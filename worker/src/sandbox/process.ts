/**
 * The development-only process runner.
 *
 * This runs the agent as an ordinary child process on the operator's machine.
 * There is no boundary: Prime Agent's Python tool executes model-generated code
 * with the same permissions as the user who started the worker. It can read
 * their documents, their SSH keys and their browser profile, and evidence is an
 * untrusted channel straight into the model's context.
 *
 * It exists because developing this worker against a container on every edit is
 * miserable, and because the fake runtime needs somewhere to run. It must never
 * be the thing a researcher is using, so it refuses to start unless the
 * operator has said so twice: once in the config file, and once by not being in
 * a production environment.
 *
 * The mode is also reported honestly to the studio as ``process``, which is why
 * that value exists in the server's enum -- the UI can then tell the researcher
 * their results came from an unsandboxed machine.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { log } from "../logging.js";
import { safeErrorMessage } from "../redact.js";
import { LineSplitter, decodeRunnerLine } from "../runtime-events.js";
import type { JobSandbox, SandboxOutcome, SandboxRunOptions } from "./types.js";

export class ProcessSandboxRefused extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
/** dist/sandbox -> dist/runner/entrypoint.js */
const ENTRYPOINT = join(here, "..", "runner", "entrypoint.js");

export interface ProcessSandboxOptions {
  allowUnsafe: boolean;
  nodeEnv: string | undefined;
}

export class ProcessSandbox implements JobSandbox {
  readonly mode = "process" as const;

  constructor(private readonly options: ProcessSandboxOptions) {
    if (!options.allowUnsafe) {
      throw new ProcessSandboxRefused(
        "The process runner executes model-generated code with your own permissions. " +
          'Set sandbox.allowUnsafeProcessRunner to true only on a machine you are willing to lose, or use sandbox.kind "container".',
      );
    }
    if (options.nodeEnv === "production") {
      throw new ProcessSandboxRefused(
        "The process runner is refused when NODE_ENV=production. Use a container sandbox.",
      );
    }
  }

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail:
        "Process runner active. There is NO sandbox: model-generated code runs with your user account's permissions.",
    };
  }

  async run(options: SandboxRunOptions): Promise<SandboxOutcome> {
    log.warn("Running a job without a sandbox", { jobId: options.jobId });
    const child = spawn(process.execPath, [ENTRYPOINT], {
      cwd: options.workspace.root,
      env: {
        // A deliberately spare environment. Inheriting the operator's shell
        // would hand the agent every credential they have exported.
        PATH: process.env["PATH"] ?? "",
        HOME: options.workspace.root,
        TMPDIR: options.workspace.root,
        NODE_ENV: "development",
        ...options.env,
        VLS_INPUT_DIR: options.workspace.inputDir,
        VLS_OUTPUT_DIR: options.workspace.outputDir,
        VLS_SANDBOX_MODE: "process",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    return collectChild(child, options);
  }
}

/**
 * Shared stdout handling for any child-process-shaped sandbox.
 *
 * Framed lines become events; everything else is diagnostic output that stays
 * on the operator's machine. Both container and process runners funnel through
 * here so the framing rule has exactly one implementation.
 */
export async function collectChild(
  child: import("node:child_process").ChildProcess,
  options: SandboxRunOptions,
): Promise<SandboxOutcome> {
  const splitter = new LineSplitter();
  let outcome: SandboxOutcome | null = null;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of splitter.push(chunk)) {
      const event = decodeRunnerLine(line);
      if (event) options.onEvent(event);
      else if (line.trim()) options.onDiagnostic(line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) options.onDiagnostic(line);
    }
  });

  const timer = setTimeout(() => {
    outcome = { status: "timeout" };
    child.kill("SIGKILL");
  }, options.maxRuntimeSeconds * 1_000);

  const onAbort = (): void => {
    if (!outcome) outcome = { status: "cancelled" };
    child.kill("SIGTERM");
    // A runtime that ignores SIGTERM must not keep spending the operator's
    // hardware after the researcher pressed cancel.
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? -1));
    });
    for (const line of splitter.flush()) {
      const event = decodeRunnerLine(line);
      if (event) options.onEvent(event);
    }
    return outcome ?? { status: "completed", exitCode };
  } catch (error) {
    return outcome ?? { status: "failed", reason: safeErrorMessage(error) };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
  }
}
