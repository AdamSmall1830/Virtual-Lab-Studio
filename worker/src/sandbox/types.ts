/**
 * The execution sandbox interface.
 *
 * Two axes are kept apart on purpose. *This* one is where the agent runs --
 * a container or, in development only, a plain child process. The other is how
 * the agent is driven once it is running, which lives in ``src/runner`` and is
 * selected inside the sandbox. Conflating them is how a "just for testing"
 * runtime ends up executing model-generated Python on someone's laptop.
 *
 * A sandbox implementation owes the caller three things: a stream of framed
 * runner events, a hard wall-clock stop, and a promise that resolves once the
 * process is gone. It is never handed the worker credential, the server URL,
 * or a model API key.
 */
import type { ModelConfig } from "../config.js";
import type { RunnerEvent } from "../runtime-events.js";
import type { JobWorkspace } from "../workspace.js";
import type { MeasuredUsage, ProxyBudget } from "./model-proxy.js";

/**
 * What the sandbox observed, independently of anything the runner said.
 *
 * Present only when the sandbox actually sits in the path of the model calls,
 * which is the container's proxy mode. Absent means "not measured" -- never
 * "measured as zero", because the difference decides whether a token limit is
 * enforceable or merely requested.
 */
export interface SandboxObservations {
  usage?: MeasuredUsage;
  /** Set when the sandbox stopped the job for spending its allowance. */
  budgetExceeded?: "tokens" | "calls";
}

export type SandboxOutcome = SandboxObservations &
  (
    | { status: "completed"; exitCode: number }
    | { status: "timeout" }
    | { status: "cancelled" }
    | { status: "failed"; reason: string }
  );

export interface SandboxRunOptions {
  jobId: string;
  workspace: JobWorkspace;
  /**
   * The model this job was leased for, chosen once by the caller.
   *
   * The sandbox is handed the resolved configuration rather than a key to look
   * up, so the endpoint its proxy dials is provably the same one the runner was
   * told about. A sandbox that resolves the model itself can disagree with the
   * job spec, and the failure is silent: the meeting is billed and reported
   * under one model while the tokens were produced by another.
   *
   * It carries the *name* of the credential's environment variable, never the
   * credential, which is read on the host at the moment the proxy is built.
   */
  model: ModelConfig;
  /** Wall-clock ceiling for the whole attempt, already clamped by the caller. */
  maxRuntimeSeconds: number;
  /** Job-scoped variables the runner needs. Never provider credentials. */
  env: Record<string, string>;
  /**
   * The meeting's allowance, enforced at the model chokepoint. Sandboxes that
   * cannot see the model calls ignore it, and say so by returning no usage.
   */
  budget?: ProxyBudget;
  /** Called for each framed event the runner emits. */
  onEvent: (event: RunnerEvent) => void;
  /** Called for unframed output, so the operator can debug their own machine. */
  onDiagnostic: (line: string) => void;
  /** Resolves when the caller wants the attempt stopped. */
  signal: AbortSignal;
}

export interface JobSandbox {
  /** Reported to the studio so the UI can state how the work was isolated. */
  readonly mode: "docker" | "rootless" | "process";
  /** Verify the sandbox can actually run, before enrolling or leasing. */
  preflight(): Promise<{ ok: boolean; detail: string }>;
  run(options: SandboxRunOptions): Promise<SandboxOutcome>;
}
