/**
 * End-to-end tests for the worker loop against a fake studio.
 *
 * The sandbox is replaced by a scripted stand-in so the loop can be driven
 * deterministically, but everything between the wire and the sandbox is the
 * real code: the real ZIP reader, the real workspace, the real normaliser, the
 * real validator. The assertions concentrate on the properties that are
 * invisible in a screenshot and expensive to get wrong -- exactly one terminal
 * call per job, no host paths on the wire, a lost lease ending the work
 * quietly, and a bounds breach stopping the run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";

import { StudioClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import type { WorkerConfig } from "../src/config.js";
import type { RunnerEvent } from "../src/runtime-events.js";
import type { JobSandbox, SandboxOutcome, SandboxRunOptions } from "../src/sandbox/types.js";
import { BridgeWorker } from "../src/worker.js";
import { FakeStudio, buildFixtureBundle, makeLease } from "./helpers/fake-server.js";

/** A sandbox that replays a script instead of starting a container. */
class ScriptedSandbox implements JobSandbox {
  readonly mode = "docker" as const;
  lastOptions: SandboxRunOptions | null = null;

  constructor(
    private readonly script: (options: SandboxRunOptions) => Promise<SandboxOutcome>,
  ) {}

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "scripted" };
  }

  async run(options: SandboxRunOptions): Promise<SandboxOutcome> {
    this.lastOptions = options;
    return this.script(options);
  }
}

function emitAll(options: SandboxRunOptions, events: RunnerEvent[]): void {
  for (const event of events) options.onEvent(event);
}

function writeResult(options: SandboxRunOptions, result: unknown): void {
  writeFileSync(options.workspace.resultPath, JSON.stringify(result), "utf8");
}

let workspaceRoot: string;

function makeConfig(overrides: Record<string, unknown> = {}): WorkerConfig {
  return parseConfig(
    {
      serverUrl: "https://studio.example.com",
      displayName: "Test worker",
      workspaceRoot,
      workerTokenFile: join(workspaceRoot, "token"),
      models: [
        {
          modelKey: "local-test",
          displayName: "Local test model",
          baseUrl: "http://127.0.0.1:11434/v1",
          providerModelId: "test-model",
          contextWindow: 32_768,
          maxTokens: 4_096,
          pricing: { input_per_million_usd: 0, output_per_million_usd: 0 },
        },
      ],
      ...overrides,
    },
    join(workspaceRoot, "worker.config.json"),
  );
}

/** Run the worker until the fake studio has settled the job, then stop it. */
async function runUntilSettled(
  studio: FakeStudio,
  worker: BridgeWorker,
  timeoutMs = 5_000,
): Promise<void> {
  const running = worker.run();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const settled =
      studio.completions.length + studio.failures.length + studio.releases.length > 0;
    if (settled && worker.activeCount === 0) break;
    await sleep(20);
  }
  worker.stop();
  await running;
}

const GOOD_EVENTS: RunnerEvent[] = [
  { kind: "runner.ready", adapter: "fake", prime_agent_version: null },
  {
    kind: "node.started",
    node_id: "coordinator",
    parent_node_id: null,
    display_name: "Participant",
    depth: 0,
  },
  { kind: "tool.started", node_id: "coordinator", tool: "evidence_search" },
  { kind: "tool.completed", node_id: "coordinator", tool: "evidence_search" },
  {
    kind: "usage",
    node_id: "coordinator",
    model_call_count: 2,
    input_tokens: 400,
    output_tokens: 120,
    cost_usd: 0,
    pricing_complete: true,
  },
  { kind: "node.completed", node_id: "coordinator", result_summary: "Reviewed the assay." },
];

describe("the worker loop", () => {
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "vls-worker-test-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("leases, runs and completes a job", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      emitAll(options, GOOD_EVENTS);
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "The assay reported a 42% yield.",
        citations: [{ evidence_key: "E1", locator: "p. 1", claim: "42% yield", support_type: "supports" }],
        limitations: ["One source only."],
        is_simulation: false,
        usage: { model_call_count: 2, input_tokens: 400, output_tokens: 120 },
        nodes: [
          {
            external_node_id: "coordinator",
            display_name: "Participant",
            status: "completed",
            result_summary: "Reviewed the assay.",
            cited_evidence_keys: ["E1"],
          },
        ],
      });
      return { status: "completed", exitCode: 0 };
    });

    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.equal(studio.completions.length, 1);
    assert.equal(studio.failures.length, 0);
    const completion = studio.completions[0];
    assert.equal(completion?.final_text, "The assay reported a 42% yield.");
    assert.equal(completion?.citations[0]?.evidence_key, "E1");
    assert.equal(completion?.runtime.is_simulation, false);
    assert.ok((completion?.usage.input_tokens ?? 0) >= 400);
  });

  it("posts progress events before the result", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      emitAll(options, GOOD_EVENTS);
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "Answer.",
        citations: [],
        limitations: [],
        nodes: [],
      });
      return { status: "completed", exitCode: 0 };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    const types = studio.events.flatMap((batch) => batch.events.map((event) => event.type));
    assert.ok(types.includes("recursive.job.started"));
    assert.ok(types.includes("recursive.agent.started"));
    assert.ok(types.includes("recursive.tool.started"));
    assert.ok(!types.some((type) => type.startsWith("recursive.job.completed")));
  });

  it("never puts a host path or credential on the wire", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      // A runtime doing its worst: paths and a key in every summary field.
      emitAll(options, [
        {
          kind: "node.started",
          node_id: "coordinator",
          parent_node_id: null,
          display_name: "Participant",
          task_summary: `reading ${options.workspace.inputDir}/evidence with sk-abcdefghijklmnopqrstuvwx`,
          depth: 0,
        },
        {
          kind: "node.completed",
          node_id: "coordinator",
          result_summary: `wrote ${options.workspace.resultPath}`,
        },
      ]);
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "Answer.",
        citations: [],
        limitations: [],
        nodes: [
          {
            external_node_id: "coordinator",
            display_name: "Participant",
            status: "completed",
            result_summary: `saved to ${options.workspace.root}`,
          },
        ],
      });
      return { status: "completed", exitCode: 0 };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    const outbound = studio.outboundStrings().join("\n");
    assert.ok(!outbound.includes(workspaceRoot), "a host path reached the wire");
    assert.ok(!outbound.includes("sk-abcdefghijklmnopqrstuvwx"), "a credential reached the wire");
  });

  it("fails the job when a citation cannot be resolved", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      emitAll(options, GOOD_EVENTS);
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "The yield was 42%.",
        citations: [{ evidence_key: "GHOST", locator: null, claim: "x", support_type: "supports" }],
        limitations: [],
        nodes: [],
      });
      return { status: "completed", exitCode: 0 };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.equal(studio.completions.length, 0);
    assert.equal(studio.failures.length, 1);
    assert.equal(studio.failures[0]?.failure_code, "invalid_result");
  });

  it("stops the run when the participant exceeds its agent bounds", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [
        makeLease({
          request_sha256: fixture.requestSha,
          limits: {
            max_children: 1,
            max_depth: 1,
            max_agent_turns: 8,
            max_tokens: 32_000,
            max_runtime_seconds: 120,
            max_cost_usd: 2,
          },
        }),
      ],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    let aborted = false;
    const sandbox = new ScriptedSandbox(async (options) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
      });
      emitAll(options, [
        { kind: "node.started", node_id: "coordinator", parent_node_id: null, display_name: "P", depth: 0 },
        { kind: "node.started", node_id: "c1", parent_node_id: "coordinator", display_name: "A", depth: 1 },
        { kind: "node.started", node_id: "c2", parent_node_id: "coordinator", display_name: "B", depth: 1 },
        { kind: "node.started", node_id: "c3", parent_node_id: "coordinator", display_name: "C", depth: 1 },
      ]);
      return { status: "completed", exitCode: 0 };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.ok(aborted, "the sandbox should have been told to stop");
    assert.equal(studio.failures[0]?.failure_code, "limit_exceeded");
    assert.equal(studio.failures[0]?.retryable, false);
  });

  it("reports a timeout rather than submitting a partial answer", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      emitAll(options, GOOD_EVENTS);
      return { status: "timeout" };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.equal(studio.completions.length, 0);
    assert.equal(studio.failures[0]?.failure_code, "timeout");
    assert.equal(studio.failures[0]?.retryable, true);
  });

  it("says nothing further about a job whose lease was taken away", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      studio.lostLeases.add("job-1");
      emitAll(options, GOOD_EVENTS);
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "Answer.",
        citations: [],
        limitations: [],
        nodes: [],
      });
      return { status: "completed", exitCode: 0 };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    const running = worker.run();
    await sleep(1_500);
    worker.stop();
    await running;

    // A lost lease means another worker owns the job. Reporting a failure would
    // be a claim about work this process no longer owns.
    assert.equal(studio.completions.length, 0);
  });

  it("releases a job whose model is no longer configured", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha, model_key: "a-model-we-dropped" })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async () => ({ status: "completed", exitCode: 0 }));
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.deepEqual(studio.releases, ["job-1"]);
    assert.equal(studio.failures.length, 0);
  });

  it("removes the job workspace whatever the outcome", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    let capturedRoot = "";
    const sandbox = new ScriptedSandbox(async (options) => {
      capturedRoot = options.workspace.root;
      return { status: "failed", reason: "the runner exploded" };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    const { existsSync } = await import("node:fs");
    assert.ok(capturedRoot.length > 0);
    assert.equal(existsSync(capturedRoot), false, "evidence was left on disk");
  });

  it("materialises the bundle and the reviewed skill into the workspace", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    let seen: string[] = [];
    const sandbox = new ScriptedSandbox(async (options) => {
      const { readdirSync, readFileSync } = await import("node:fs");
      seen = readdirSync(options.workspace.inputDir).sort();
      const spec = JSON.parse(
        readFileSync(join(options.workspace.inputDir, "job.json"), "utf8"),
      ) as { allowed_skill_ids: string[] };
      assert.deepEqual(spec.allowed_skill_ids, ["vls_evidence"]);
      return { status: "failed", reason: "inspection only" };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.deepEqual(seen, [
      "evidence",
      "evidence-manifest.json",
      "job.json",
      "request.json",
      "skills",
      "task.md",
    ]);
  });

  it("bills the turn on what the sandbox measured, not on what the runner claimed", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      emitAll(options, [
        {
          kind: "node.started",
          node_id: "coordinator",
          parent_node_id: null,
          display_name: "Participant",
          depth: 0,
        },
        // A modified runner reporting that its work was free.
        {
          kind: "usage",
          node_id: "coordinator",
          model_call_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          pricing_complete: true,
        },
        { kind: "node.completed", node_id: "coordinator", result_summary: "Done." },
      ]);
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "An answer that cost nothing at all.",
        citations: [],
        limitations: [],
        usage: { model_call_count: 0, input_tokens: 0, output_tokens: 0 },
        nodes: [
          {
            external_node_id: "coordinator",
            display_name: "Participant",
            status: "completed",
            result_summary: "Done.",
            cited_evidence_keys: [],
          },
        ],
      });
      // What the proxy watched go past on the way to the model.
      return {
        status: "completed",
        exitCode: 0,
        usage: {
          model_call_count: 11,
          input_tokens: 9_000,
          output_tokens: 2_500,
          unmeasured_calls: 0,
        },
      };
    });
    const config = makeConfig({
      models: [
        {
          modelKey: "local-test",
          displayName: "A model with a bill",
          baseUrl: "http://127.0.0.1:11434/v1",
          providerModelId: "test-model",
          contextWindow: 32_768,
          maxTokens: 4_096,
          pricing: { input_per_million_usd: 10, output_per_million_usd: 30 },
        },
      ],
    });
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    const usage = studio.completions[0]?.usage;
    assert.equal(usage?.input_tokens, 9_000);
    assert.equal(usage?.output_tokens, 2_500);
    assert.equal(usage?.model_call_count, 11);
    // 9000 in at $10/M plus 2500 out at $30/M.
    assert.equal(usage?.cost_usd, 0.165);
    assert.equal(usage?.pricing_complete, true);
  });

  it("says the cost is incomplete when some calls could not be measured", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      emitAll(options, GOOD_EVENTS);
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "The assay reported a 42% yield.",
        citations: [],
        limitations: [],
        nodes: [
          {
            external_node_id: "coordinator",
            display_name: "Participant",
            status: "completed",
            result_summary: "Reviewed the assay.",
            cited_evidence_keys: [],
          },
        ],
      });
      return {
        status: "completed",
        exitCode: 0,
        usage: {
          model_call_count: 4,
          input_tokens: 500,
          output_tokens: 200,
          unmeasured_calls: 2,
        },
      };
    });
    const config = makeConfig({
      models: [
        {
          modelKey: "local-test",
          displayName: "A model with a bill",
          baseUrl: "http://127.0.0.1:11434/v1",
          providerModelId: "test-model",
          contextWindow: 32_768,
          maxTokens: 4_096,
          pricing: { input_per_million_usd: 10, output_per_million_usd: 30 },
        },
      ],
    });
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.equal(studio.completions[0]?.usage.pricing_complete, false);
  });

  it("refuses a result from a turn that spent more than the meeting allowed", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async (options) => {
      emitAll(options, GOOD_EVENTS);
      // A complete, plausible-looking answer. It is still not admissible: the
      // work behind it ran past the budget the researcher agreed to.
      writeResult(options, {
        request_sha256: fixture.requestSha,
        final_text: "A perfectly good answer, produced over budget.",
        citations: [],
        limitations: [],
        nodes: [],
      });
      return {
        status: "completed",
        exitCode: 0,
        budgetExceeded: "tokens",
        usage: {
          model_call_count: 40,
          input_tokens: 40_000,
          output_tokens: 5_000,
          unmeasured_calls: 0,
        },
      };
    });
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.equal(studio.completions.length, 0);
    assert.equal(studio.failures[0]?.failure_code, "limit_exceeded");
    assert.equal(studio.failures[0]?.retryable, false);
    // The overspend is reported, not quietly dropped with the result.
    assert.equal(studio.failures[0]?.usage.input_tokens, 40_000);
  });

  it("hands the meeting's allowance to the sandbox as an enforceable budget", async () => {
    const fixture = buildFixtureBundle();
    const studio = new FakeStudio({
      queue: [makeLease({ request_sha256: fixture.requestSha })],
      bundles: new Map([[fixture.jobId, fixture.bytes]]),
    });
    const sandbox = new ScriptedSandbox(async () => ({
      status: "failed",
      reason: "inspection only",
    }));
    const config = makeConfig();
    const worker = new BridgeWorker({
      config,
      client: new StudioClient({
        baseUrl: config.serverUrl,
        token: "vlsw_test",
        userAgent: "test",
        fetchImpl: studio.fetch,
      }),
      sandbox,
    });
    await runUntilSettled(studio, worker);

    assert.equal(sandbox.lastOptions?.budget?.maxTokens, 32_000);
    assert.ok((sandbox.lastOptions?.budget?.maxCalls ?? 0) >= 32);
  });
});
