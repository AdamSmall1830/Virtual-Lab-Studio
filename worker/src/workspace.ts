/**
 * The disposable job workspace.
 *
 * One directory per attempt, created fresh and removed when the attempt ends,
 * whatever the outcome. Nothing survives a job: not the evidence, not the
 * agent's session file, not the Python scratch files. A researcher's frozen
 * literature should not still be sitting on the operator's laptop a week
 * later, and a second job must not be able to read the first one's leftovers.
 *
 * The layout is fixed so the container's mount arguments are constants:
 *
 *   <root>/<job-id>-<attempt>-<nonce>/
 *     input/                 mounted read-only at /job/input
 *       task.md              the immutable brief
 *       request.json         the immutable request contract
 *       job.json             limits, model ids, capability profile
 *       evidence-manifest.json
 *       evidence/*.txt       one file per frozen source
 *       skills/vls_evidence/ the reviewed read-only evidence skill
 *     output/                mounted read-write at /job/output
 *       events.jsonl         normalised progress, written by the runner
 *       result.json          the typed result
 *
 * Every filename above is a literal in this file. None is derived from the
 * bundle: see bundle.ts for why that matters.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JobBundle } from "./bundle.js";
import { log } from "./logging.js";
import type { LeasedJob } from "./protocol.js";
import { safeErrorMessage } from "./redact.js";
import { EVIDENCE_SKILL_FILES } from "./skill-content.js";

export interface JobWorkspace {
  readonly root: string;
  readonly inputDir: string;
  readonly outputDir: string;
  readonly eventsPath: string;
  readonly resultPath: string;
  dispose(): void;
}

/**
 * What the runner inside the sandbox is told about the job.
 *
 * Deliberately narrow: the runner never learns the server URL, the worker
 * credential, the workspace id or anything about other jobs. If the sandbox
 * were broken out of, this file is the whole of what the attacker gains.
 */
export interface RunnerJobSpec {
  schema_version: "1.0";
  job_id: string;
  attempt: number;
  request_sha256: string;
  capability_profile: string;
  model_key: string;
  child_model_key: string | null;
  allowed_skill_ids: string[];
  limits: LeasedJob["limits"];
  /** Where the runner reaches a model. Always the narrow proxy, never a key. */
  model_endpoint: {
    base_url: string;
    /** The provider model id for the coordinator. */
    model_id: string;
    /** The provider model id for children, when a different model was chosen. */
    child_model_id: string | null;
    context_window: number;
    max_tokens: number;
  };
}

function writeUtf8(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}

export function createJobWorkspace(
  workspaceRoot: string,
  job: LeasedJob,
  bundle: JobBundle,
  spec: RunnerJobSpec,
): JobWorkspace {
  const nonce = randomBytes(6).toString("hex");
  const root = resolve(workspaceRoot, `${job.job_id}-a${job.attempt}-${nonce}`);
  if (existsSync(root)) {
    throw new Error("The job workspace already exists; refusing to reuse it.");
  }
  const inputDir = join(root, "input");
  const outputDir = join(root, "output");
  const evidenceDir = join(inputDir, "evidence");
  const skillDir = join(inputDir, "skills", "vls_evidence");

  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  // The container runs as an unprivileged, unrelated uid, so it needs to be
  // able to traverse in and write out. Only this attempt's directory is
  // exposed, and it is destroyed when the attempt ends.
  mkdirSync(outputDir, { recursive: true, mode: 0o777 });
  try {
    chmodSync(outputDir, 0o777);
  } catch {
    // Windows has no POSIX mode; Docker Desktop handles the mapping itself.
  }

  writeUtf8(join(inputDir, "task.md"), bundle.taskMarkdown);
  writeUtf8(join(inputDir, "request.json"), JSON.stringify(bundle.request, null, 2));
  writeUtf8(join(inputDir, "job.json"), JSON.stringify(spec, null, 2));
  writeUtf8(
    join(inputDir, "evidence-manifest.json"),
    JSON.stringify(bundle.manifest, null, 2),
  );

  for (const entry of bundle.manifest.evidence) {
    const text = bundle.evidence.get(entry.file);
    if (text === undefined) continue;
    // entry.file was matched against the closed pattern in readBundle, and the
    // basename is re-derived here rather than reused as a path.
    const base = entry.file.slice("evidence/".length);
    writeUtf8(join(evidenceDir, base), text);
  }

  for (const [name, content] of Object.entries(EVIDENCE_SKILL_FILES)) {
    writeUtf8(join(skillDir, name), content);
  }

  const eventsPath = join(outputDir, "events.jsonl");
  const resultPath = join(outputDir, "result.json");
  // Pre-create the event log so a tail can start before the container does.
  writeFileSync(eventsPath, "", { encoding: "utf8", mode: 0o666 });
  try {
    chmodSync(eventsPath, 0o666);
  } catch {
    // See above.
  }

  return {
    root,
    inputDir,
    outputDir,
    eventsPath,
    resultPath,
    dispose(): void {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        // Worth surfacing: a workspace that will not delete is evidence left
        // on disk, and the operator is the only one who can clear it.
        log.warn("Could not remove the job workspace", {
          root,
          reason: safeErrorMessage(error),
        });
      }
    },
  };
}

/** Remove any workspaces left behind by a crash on a previous run. */
export function purgeStaleWorkspaces(workspaceRoot: string): void {
  if (!existsSync(workspaceRoot)) {
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    return;
  }
  try {
    rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    log.warn("Could not clear the workspace root", { reason: safeErrorMessage(error) });
  }
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
}
