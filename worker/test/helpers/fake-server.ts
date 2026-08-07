/**
 * A fake Virtual Lab Studio, in memory.
 *
 * The worker's job is to behave correctly against a server that is sometimes
 * slow, sometimes duplicating, and sometimes taking a job away mid-flight. A
 * fake that only ever answers 200 would let all of that go untested, so this
 * one can be told to fail, to drop a lease, or to reject a batch.
 *
 * It also records every request, which is how the tests assert the things that
 * matter most and are otherwise invisible: that no host path ever appeared in
 * an outbound payload, that a terminal call was made exactly once, and that a
 * simulated run was labelled as simulated.
 */
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

import type {
  CompletionRequest,
  EventBatch,
  FailRequest,
  LeasedJob,
} from "../../src/protocol.js";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeServerOptions {
  /** Jobs handed out, in order, one per lease call. */
  queue?: LeasedJob[];
  /** Bundle bytes keyed by job id. */
  bundles?: Map<string, Uint8Array>;
  /** Force the next N lease calls to 204. */
  emptyLeases?: number;
}

export class FakeStudio {
  readonly requests: RecordedRequest[] = [];
  readonly events: EventBatch[] = [];
  readonly completions: CompletionRequest[] = [];
  readonly failures: FailRequest[] = [];
  readonly releases: string[] = [];

  private readonly queue: LeasedJob[];
  private readonly bundles: Map<string, Uint8Array>;
  /** Set to make the next call of that kind fail. */
  failNext = new Map<string, { status: number; code: string }>();
  /** Job ids whose lease has been taken away. */
  lostLeases = new Set<string>();
  cancelJobs = new Set<string>();
  heartbeatCount = 0;

  constructor(options: FakeServerOptions = {}) {
    this.queue = [...(options.queue ?? [])];
    this.bundles = options.bundles ?? new Map();
  }

  /** A ``fetch`` implementation to hand to StudioClient. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    let body: unknown = undefined;
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    this.requests.push({ method, path, body });

    const forced = this.failNext.get(path);
    if (forced) {
      this.failNext.delete(path);
      return this.json(forced.status, { detail: { code: forced.code, message: "forced" } });
    }

    if (path === "/api/v1/recursive-workers/enroll") {
      return this.json(201, {
        worker_id: "worker-1",
        workspace_id: "workspace-1",
        display_name: "Test worker",
        worker_token: "vlsw_test_token",
        heartbeat_interval_seconds: 20,
        lease_poll_interval_seconds: 5,
      });
    }

    if (path === "/api/v1/recursive-workers/heartbeat") {
      this.heartbeatCount += 1;
      return this.json(200, {
        worker_id: "worker-1",
        status: "online",
        heartbeat_interval_seconds: 20,
        lease_poll_interval_seconds: 5,
        job_controls: Array.from(this.cancelJobs).map((jobId) => ({
          job_id: jobId,
          cancel_requested: true,
          pause_requested: false,
        })),
      });
    }

    if (path === "/api/v1/recursive-workers/jobs/lease") {
      const next = this.queue.shift();
      if (!next) return new Response(null, { status: 204 });
      return this.json(200, next);
    }

    const jobMatch = /^\/api\/v1\/recursive-jobs\/([^/]+)\/(\w+)$/.exec(path);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1] ?? "");
      const action = jobMatch[2] ?? "";
      if (this.lostLeases.has(jobId) && action !== "bundle") {
        return this.json(409, { detail: { code: "lease_lost", message: "The lease was lost." } });
      }
      switch (action) {
        case "bundle": {
          const bytes = this.bundles.get(jobId);
          if (!bytes) return this.json(404, { detail: { code: "not_found", message: "no bundle" } });
          return new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/zip" },
          });
        }
        case "heartbeat":
          return this.json(200, {
            job_id: jobId,
            cancel_requested: this.cancelJobs.has(jobId),
            pause_requested: false,
          });
        case "events": {
          this.events.push(body as EventBatch);
          const batch = body as EventBatch;
          return this.json(202, {
            accepted: batch.events.length,
            duplicates: 0,
            rejected: 0,
          });
        }
        case "complete":
          this.completions.push(body as CompletionRequest);
          return this.json(200, { job_id: jobId, status: "succeeded", accepted: true, detail: null });
        case "fail":
          this.failures.push(body as FailRequest);
          return this.json(200, { job_id: jobId, status: "failed", accepted: true, detail: null });
        case "release":
          this.releases.push(jobId);
          return this.json(200, { job_id: jobId, status: "queued", accepted: true, detail: null });
        default:
          break;
      }
    }

    return this.json(404, { detail: { code: "not_found", message: path } });
  };

  private json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /** Every string that has ever appeared in an outbound payload. */
  outboundStrings(): string[] {
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") found.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") Object.values(node).forEach(walk);
    };
    this.requests.forEach((request) => walk(request.body));
    return found;
  }
}

// ---------------------------------------------------------------------------
// Bundle building
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  content: Buffer;
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

/** Build a real ZIP so the reader is exercised, not stubbed. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "latin1");
    const deflated = deflateRawSync(entry.content);
    const crc = crc32(entry.content);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...locals, centralBuffer, end]));
}

export interface FixtureOptions {
  jobId?: string;
  evidence?: { key: string; text: string }[];
  taskMarkdown?: string;
}

export function buildFixtureBundle(options: FixtureOptions = {}): {
  jobId: string;
  requestSha: string;
  bytes: Uint8Array;
} {
  const jobId = options.jobId ?? "job-1";
  const evidence = options.evidence ?? [
    { key: "E1", text: "[p. 1]\nThe assay reported a 42 percent yield under standard conditions." },
  ];
  const request = {
    schema_version: "1.0",
    assignment: { job_id: jobId },
    execution: { profile: "research_read_only", allow_web: false },
  };
  const requestJson = JSON.stringify(request, null, 2);
  const requestSha = createHash("sha256").update(requestJson).digest("hex");
  const manifest = {
    schema_version: "1.0",
    job_id: jobId,
    request_sha256: requestSha,
    meeting_definition_sha256: "0".repeat(64),
    evidence: evidence.map((item, index) => ({
      evidence_key: item.key,
      file: `evidence/source-${index}.txt`,
      title: `Source ${index}`,
      citation: `Source ${index} (2026)`,
      content_sha256: createHash("sha256").update(item.text).digest("hex"),
      chunk_count: 1,
      truncated: false,
      trust: "untrusted_data",
    })),
  };
  const entries: ZipEntry[] = [
    { name: "request.json", content: Buffer.from(requestJson, "utf8") },
    {
      name: "task.md",
      content: Buffer.from(options.taskMarkdown ?? "# Your turn\n\nSummarise the evidence.\n", "utf8"),
    },
    { name: "evidence-manifest.json", content: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    ...evidence.map((item, index) => ({
      name: `evidence/source-${index}.txt`,
      content: Buffer.from(item.text, "utf8"),
    })),
  ];
  return { jobId, requestSha, bytes: buildZip(entries) };
}

export function makeLease(overrides: Partial<LeasedJob> = {}): LeasedJob {
  return {
    job_id: "job-1",
    run_id: "run-1",
    attempt: 1,
    request_sha256: "0".repeat(64),
    capability_profile: "research_read_only",
    model_key: "local-test",
    child_model_key: null,
    limits: {
      max_children: 3,
      max_depth: 1,
      max_agent_turns: 8,
      max_tokens: 32_000,
      max_runtime_seconds: 120,
      max_cost_usd: 2,
    },
    allowed_skill_ids: ["vls_evidence"],
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    heartbeat_interval_seconds: 20,
    bundle_url: "/api/v1/recursive-jobs/job-1/bundle",
    ...overrides,
  };
}
