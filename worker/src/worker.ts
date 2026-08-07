/**
 * The worker loop.
 *
 * The shape is: heartbeat on a timer, poll for a lease when there is a free
 * slot, and run each leased job to a terminal state. Everything interesting is
 * in how those three interact.
 *
 * *The heartbeat is the only control channel.* The studio cannot call this
 * machine, so a cancellation reaches the worker as a flag on a heartbeat
 * response. That is why the heartbeat keeps running while jobs are in flight,
 * and why naming a job in ``active_job_ids`` doubles as renewing its lease --
 * one call, one round trip, whatever the operator's connection is doing.
 *
 * *A lease is a countdown, not a claim.* If this process dies mid-job the
 * server hands the work to someone else once the lease expires, so the job
 * heartbeat has to keep pace with long model calls. A lost lease is not an
 * error to retry: another worker owns the job now, and continuing would spend
 * the operator's hardware producing a result the server will discard.
 *
 * *Every job ends in exactly one terminal call.* complete, fail or release.
 * A job that ends silently sits in the researcher's run until the lease times
 * out and shows as a mysterious stall, so the terminal call is in a finally
 * block and the failure path has no branch that can skip it.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { readBundle } from "./bundle.js";
import { ApiError, StudioClient, TransportError } from "./client.js";
import type { ModelConfig, WorkerConfig } from "./config.js";
import { EventNormalizer } from "./events.js";
import { log } from "./logging.js";
import {
  ADAPTER_VERSION,
  LIMITS,
  PINNED_AGENT_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  SUPPORTED_PROFILE,
  emptyUsage,
} from "./protocol.js";
import type {
  FailureCode,
  HeartbeatRequest,
  JobControl,
  LeasedJob,
  UsageReport,
  WorkerModelReport,
  WorkerReport,
} from "./protocol.js";
import { safeErrorMessage } from "./redact.js";
import { ResultRejected, buildCompletion, completionFingerprint } from "./result.js";
import type { MeasuredUsage } from "./sandbox/model-proxy.js";
import type { JobSandbox } from "./sandbox/types.js";
import { createJobWorkspace, purgeStaleWorkspaces } from "./workspace.js";
import type { RunnerJobSpec } from "./workspace.js";

const EVENT_FLUSH_INTERVAL_MS = 2_000;

export interface WorkerDeps {
  config: WorkerConfig;
  client: StudioClient;
  sandbox: JobSandbox;
  /** Injected so tests can drive the clock. */
  now?: () => number;
}

function modelReport(model: ModelConfig): WorkerModelReport {
  return {
    model_key: model.modelKey,
    display_name: model.displayName,
    provider_kind: "openai_compatible",
    context_window: model.contextWindow,
    supports_recursive_agents: model.supportsTools,
    supports_tools: model.supportsTools,
    pricing: model.pricing,
  };
}

export function buildWorkerReport(config: WorkerConfig, sandbox: JobSandbox): WorkerReport {
  return {
    adapter_version: ADAPTER_VERSION,
    prime_agent_version: PINNED_AGENT_VERSION,
    sandbox_mode: sandbox.mode,
    capabilities: {
      profiles: [SUPPORTED_PROFILE],
      // Advertised as this build's ceiling. The server clamps against the
      // deployment's own maximum, and the job's limits win over both.
      max_depth: 2,
      max_children: 8,
      python: true,
      // Never true. Recursive participants have no web access by design, and
      // claiming otherwise would let the studio schedule work this worker
      // cannot honestly do.
      web: false,
    },
    model_catalog: config.models.map(modelReport),
  };
}

interface ActiveJob {
  job: LeasedJob;
  abort: AbortController;
  cancelled: boolean;
  /**
   * Set the moment the studio says this lease belongs to someone else.
   *
   * Aborting alone is not enough. Between noticing the loss and unwinding, the
   * job still has a terminal call queued behind it, and the studio may already
   * have handed the work to another worker. Reporting a failure then would
   * overwrite a result this process no longer has any claim to, so the flag is
   * checked before anything terminal is sent rather than inferred from the
   * abort having fired -- cancellation and timeouts abort too.
   */
  leaseLost: boolean;
}

export class BridgeWorker {
  private readonly active = new Map<string, ActiveJob>();
  private readonly config: WorkerConfig;
  private readonly client: StudioClient;
  private readonly sandbox: JobSandbox;
  private readonly now: () => number;
  private heartbeatIntervalMs = 20_000;
  private leaseIntervalMs = 5_000;
  private stopping = false;
  /**
   * Wakes both loops out of their poll interval when the operator asks to stop.
   * Without it, Ctrl-C on an idle worker would sit there for up to a heartbeat
   * interval doing nothing visible, which reads as a hang.
   */
  private readonly wake = new AbortController();

  constructor(deps: WorkerDeps) {
    this.config = deps.config;
    this.client = deps.client;
    this.sandbox = deps.sandbox;
    this.now = deps.now ?? Date.now;
  }

  get activeCount(): number {
    return this.active.size;
  }

  stop(): void {
    this.stopping = true;
    for (const entry of this.active.values()) entry.abort.abort();
    if (!this.wake.signal.aborted) this.wake.abort();
  }

  /** Sleep, unless the worker is asked to stop first. */
  private async pause(ms: number): Promise<void> {
    if (this.stopping) return;
    try {
      await sleep(ms, undefined, { signal: this.wake.signal });
    } catch {
      // Aborted: stop() was called, and the caller's loop condition will see it.
    }
  }

  /** Run until stopped. Resolves once every in-flight job has settled. */
  async run(): Promise<void> {
    purgeStaleWorkspaces(this.config.workspaceRoot);
    const heartbeat = this.heartbeatLoop();
    const lease = this.leaseLoop();
    await Promise.all([heartbeat, lease]);
    // Give in-flight jobs their terminal call before the process exits.
    while (this.active.size > 0) await sleep(200);
  }

  private health(): HeartbeatRequest["health"] {
    return {
      prime_agent: "ok",
      sandbox: "ok",
      models: this.config.models.length > 0 ? "ok" : "error",
      safe_message: null,
    };
  }

  private async heartbeatLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const response = await this.client.heartbeat({
          ...buildWorkerReport(this.config, this.sandbox),
          active_job_ids: Array.from(this.active.keys()),
          capacity: {
            max_concurrent_jobs: this.config.concurrency,
            available_slots: Math.max(0, this.config.concurrency - this.active.size),
          },
          health: this.health(),
        });
        this.heartbeatIntervalMs = Math.max(5_000, response.heartbeat_interval_seconds * 1_000);
        this.leaseIntervalMs = Math.max(1_000, response.lease_poll_interval_seconds * 1_000);
        this.applyControls(response.job_controls);
      } catch (error) {
        if (error instanceof ApiError && error.isAuthFailure) {
          // The credential is gone or the worker was disabled in the studio.
          // Retrying cannot fix either, and continuing to poll would hammer a
          // server that has already said no.
          log.error("The studio rejected this worker's credential; stopping.", {
            reason: error.message,
          });
          this.stop();
          return;
        }
        log.warn("Heartbeat failed", { reason: safeErrorMessage(error) });
      }
      await this.pause(this.heartbeatIntervalMs);
    }
  }

  private applyControls(controls: JobControl[]): void {
    for (const control of controls) {
      const entry = this.active.get(control.job_id);
      if (!entry) continue;
      if (control.cancel_requested && !entry.cancelled) {
        log.info("The researcher cancelled this job", { jobId: control.job_id });
        entry.cancelled = true;
        entry.abort.abort();
      } else if (control.pause_requested && !entry.cancelled) {
        log.info("The researcher paused this job", { jobId: control.job_id });
        entry.cancelled = true;
        entry.abort.abort();
      }
    }
  }

  private async leaseLoop(): Promise<void> {
    while (!this.stopping) {
      const slots = this.config.concurrency - this.active.size;
      if (slots <= 0 || !this.client.hasToken) {
        await this.pause(this.leaseIntervalMs);
        continue;
      }
      try {
        const job = await this.client.leaseJob({
          available_slots: slots,
          supported_profiles: [SUPPORTED_PROFILE],
          model_keys: this.config.models.map((model) => model.modelKey),
        });
        if (!job) {
          await this.pause(this.leaseIntervalMs);
          continue;
        }
        void this.runJob(job);
        // Immediately look again: a queue that just produced one job often has
        // more, and the poll interval is tuned for an idle worker.
        continue;
      } catch (error) {
        if (error instanceof ApiError && error.isAuthFailure) {
          log.error("The studio rejected this worker's credential; stopping.", {
            reason: error.message,
          });
          this.stop();
          return;
        }
        log.warn("Could not lease a job", { reason: safeErrorMessage(error) });
      }
      await this.pause(this.leaseIntervalMs);
    }
  }

  private modelFor(job: LeasedJob): ModelConfig | null {
    return this.config.models.find((model) => model.modelKey === job.model_key) ?? null;
  }

  private buildSpec(job: LeasedJob, model: ModelConfig): RunnerJobSpec {
    const child = job.child_model_key
      ? (this.config.models.find((m) => m.modelKey === job.child_model_key) ?? model)
      : null;
    return {
      schema_version: "1.0",
      job_id: job.job_id,
      attempt: job.attempt,
      request_sha256: job.request_sha256,
      capability_profile: job.capability_profile,
      model_key: model.modelKey,
      child_model_key: child?.modelKey ?? null,
      allowed_skill_ids: job.allowed_skill_ids,
      limits: job.limits,
      model_endpoint: {
        // Replaced by the sandbox with the proxy address; kept here so a
        // process-mode run has something to talk to.
        base_url: model.baseUrl,
        model_id: model.providerModelId,
        child_model_id: child ? child.providerModelId : null,
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
      },
    };
  }

  /** Run one job from lease to terminal call. Never throws. */
  private async runJob(job: LeasedJob): Promise<void> {
    const entry: ActiveJob = {
      job,
      abort: new AbortController(),
      cancelled: false,
      leaseLost: false,
    };
    this.active.set(job.job_id, entry);
    const startedAt = this.now();
    const normalizer = new EventNormalizer({
      jobId: job.job_id,
      limits: job.limits,
      now: this.now,
    });
    let workspace: ReturnType<typeof createJobWorkspace> | null = null;
    let settled = false;
    /**
     * What the sandbox measured at the model chokepoint, once it is known.
     *
     * Held out here so that every exit from this method -- success, refusal,
     * crash, or the finally block -- reports the same consumption. A failure
     * path that reported only the runner's self-declared usage would let a job
     * that blew its budget be recorded as having spent nothing.
     */
    let measuredUsage: MeasuredUsage | undefined;
    const currentUsage = (): UsageReport =>
      this.mergeUsage(normalizer.usage.total, measuredUsage);

    const flush = async (): Promise<void> => {
      while (normalizer.pending > 0) {
        const batch = normalizer.peek(LIMITS.eventBatchMax);
        if (batch.length === 0) return;
        try {
          await this.client.postEvents(job.job_id, {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            events: batch,
          });
          normalizer.ack(batch.length);
        } catch (error) {
          if (error instanceof ApiError && error.isLeaseLost) throw error;
          // Progress is not worth failing a job over. The result still carries
          // the tree, so a researcher watching live sees a gap, not a loss.
          log.warn("Could not deliver progress events", { reason: safeErrorMessage(error) });
          return;
        }
      }
    };

    const heartbeatTimer = setInterval(() => {
      void this.client.jobHeartbeat(job.job_id).catch((error: unknown) => {
        if (error instanceof ApiError && error.isLeaseLost) {
          log.warn("This job's lease was lost; stopping work on it", { jobId: job.job_id });
          entry.leaseLost = true;
          entry.abort.abort();
        }
      });
    }, Math.max(5_000, job.heartbeat_interval_seconds * 1_000));

    const flushTimer = setInterval(() => {
      void flush().catch((error: unknown) => {
        if (error instanceof ApiError && error.isLeaseLost) {
          entry.leaseLost = true;
          entry.abort.abort();
        }
      });
    }, EVENT_FLUSH_INTERVAL_MS);

    const finishWithFailure = async (
      code: FailureCode,
      message: string,
      retryable: boolean,
      usage: UsageReport,
    ): Promise<void> => {
      if (settled) return;
      if (entry.leaseLost) {
        // The studio reassigned this job. A failure posted now would land on
        // whatever the new owner is doing with it.
        log.warn("Not reporting an outcome for a job this worker no longer owns", {
          jobId: job.job_id,
        });
        settled = true;
        return;
      }
      settled = true;
      try {
        await this.client.failJob(job.job_id, {
          failure_code: code,
          safe_message: message,
          retryable,
          usage,
        });
      } catch (error) {
        log.warn("Could not report the failure", { reason: safeErrorMessage(error) });
      }
    };

    try {
      const model = this.modelFor(job);
      if (!model) {
        // The studio offered work for a model this worker no longer advertises
        // -- config edited since the last heartbeat. Release rather than fail:
        // nothing is wrong with the job.
        await this.client.releaseJob(job.job_id).catch(() => undefined);
        settled = true;
        return;
      }

      const bundleBytes = await this.client.fetchBundle(job.job_id, job.bundle_url);
      const bundle = readBundle(bundleBytes, job.job_id, job.request_sha256);
      const spec = this.buildSpec(job, model);
      workspace = createJobWorkspace(this.config.workspaceRoot, job, bundle, spec);

      normalizer.jobStarted(model.modelKey);
      await flush();

      const runtimeEnv: Record<string, string> = {
        VLS_AGENT_RUNTIME: this.config.agentRuntime,
      };

      const maxRuntime = Math.min(
        job.limits.max_runtime_seconds,
        this.config.sandbox.maxRuntimeSecondsCeiling,
      );

      let boundsBreach: "count" | "depth" | null = null;
      const outcome = await this.sandbox.run({
        jobId: job.job_id,
        workspace,
        // The same model object the spec was built from, so the endpoint the
        // sandbox proxies to cannot drift from the one the runner was told to
        // use -- and so a multi-model worker never answers with the wrong one.
        model,
        maxRuntimeSeconds: maxRuntime,
        env: runtimeEnv,
        budget: {
          maxTokens: job.limits.max_tokens,
          // A backstop against a runaway loop whose responses declare no usage,
          // not a turn count: one agent turn legitimately makes several model
          // calls as it works through its tools.
          maxCalls: Math.max(
            32,
            job.limits.max_agent_turns * (job.limits.max_children + 1) * 4,
          ),
          // Legitimate parallelism is one call per live agent; anything beyond
          // that is a runner opening sockets rather than doing research.
          maxConcurrent: Math.max(4, job.limits.max_children + 1),
        },
        signal: entry.abort.signal,
        onEvent: (event) => {
          const verdict = normalizer.ingest(event);
          if (verdict.boundsViolation && !boundsBreach) {
            boundsBreach = verdict.boundsViolation;
            // The participant is trying to exceed the experiment's shape. Stop
            // it here rather than discovering it at validation time, so the
            // operator's hardware is not spent on a result that cannot be used.
            log.warn("The participant exceeded its agent bounds; stopping the job", {
              jobId: job.job_id,
              breach: boundsBreach,
            });
            entry.abort.abort();
          }
        },
        onDiagnostic: (line) => log.debug("sandbox", { line }),
      });

      await flush().catch(() => undefined);

      // Measured at the model chokepoint, so it stands whatever the runner
      // chose to report. Everything below prices and validates against it.
      measuredUsage = outcome.usage;

      if (entry.cancelled) {
        await finishWithFailure(
          "cancelled",
          "The researcher cancelled this turn.",
          false,
          currentUsage(),
        );
        return;
      }
      if (outcome.budgetExceeded) {
        await finishWithFailure(
          "limit_exceeded",
          outcome.budgetExceeded === "tokens"
            ? `The turn used more than the ${job.limits.max_tokens} tokens this meeting allows.`
            : "The turn made far more model calls than this meeting's turn limit allows.",
          false,
          currentUsage(),
        );
        return;
      }
      if (boundsBreach) {
        await finishWithFailure(
          "limit_exceeded",
          boundsBreach === "depth"
            ? "The participant tried to nest agents deeper than this meeting allows."
            : "The participant tried to create more agents than this meeting allows.",
          false,
          currentUsage(),
        );
        return;
      }
      if (outcome.status === "timeout") {
        await finishWithFailure(
          "timeout",
          `The turn ran past its ${maxRuntime}-second limit and was stopped.`,
          true,
          currentUsage(),
        );
        return;
      }
      if (outcome.status === "cancelled") {
        await finishWithFailure("cancelled", "The turn was stopped.", true, currentUsage());
        return;
      }
      if (outcome.status === "failed") {
        await finishWithFailure("sandbox_error", outcome.reason, true, currentUsage());
        return;
      }

      if (!existsSync(workspace.resultPath)) {
        await finishWithFailure(
          "worker_error",
          "The participant produced no result file.",
          true,
          currentUsage(),
        );
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(workspace.resultPath, "utf8"));
      } catch {
        await finishWithFailure(
          "invalid_result",
          "The participant's result could not be read.",
          true,
          currentUsage(),
        );
        return;
      }

      const record = raw as Record<string, unknown>;
      if (typeof record["failure"] === "string" && record["failure"]) {
        await finishWithFailure(
          "model_error",
          safeErrorMessage(record["failure"]),
          true,
          currentUsage(),
        );
        return;
      }

      const isSimulation = record["is_simulation"] === true;
      const usage = this.priceUsage(currentUsage(), model, record, measuredUsage);

      let completion;
      try {
        completion = buildCompletion(raw, {
          requestSha256: job.request_sha256,
          limits: job.limits,
          manifest: bundle.manifest,
          ledger: normalizer.ledger,
          usage,
          nodeUsage: normalizer.usage.perNode,
          runtime: {
            adapter_version: ADAPTER_VERSION,
            prime_agent_version:
              typeof record["prime_agent_version"] === "string"
                ? record["prime_agent_version"]
                : null,
            model_key: model.modelKey,
            child_model_key: job.child_model_key,
            elapsed_ms: this.now() - startedAt,
            // Carried straight through. A simulated turn must be labelled as
            // one in the research record; nothing downstream can recover this
            // fact if the worker drops it.
            is_simulation: isSimulation,
            session_reference_hash: createHash("sha256")
              .update(`${job.job_id}:${job.attempt}:${randomUUID()}`)
              .digest("hex"),
          },
        });
      } catch (error) {
        if (error instanceof ResultRejected) {
          await finishWithFailure(
            error.failureCode,
            error.message,
            error.retryable,
            currentUsage(),
          );
          return;
        }
        throw error;
      }

      if (entry.leaseLost) {
        log.warn("Discarding a finished result for a job this worker no longer owns", {
          jobId: job.job_id,
        });
        settled = true;
        return;
      }
      settled = true;
      const ack = await this.client.completeJob(job.job_id, completion);
      log.info("Submitted the participant's response", {
        jobId: job.job_id,
        accepted: ack.accepted,
        detail: ack.detail ?? undefined,
        fingerprint: completionFingerprint(completion).slice(0, 12),
        simulated: isSimulation,
      });
    } catch (error) {
      if (error instanceof ApiError && error.isLeaseLost) {
        // Another worker owns this job now. Saying anything further about it
        // would be a lie about work this process no longer owns.
        log.warn("The lease was lost before this job could be settled", { jobId: job.job_id });
        settled = true;
      } else if (error instanceof TransportError) {
        await finishWithFailure(
          "worker_error",
          "The worker lost contact with the studio during this turn.",
          true,
          currentUsage(),
        ).catch(() => undefined);
      } else {
        await finishWithFailure(
          "worker_error",
          safeErrorMessage(error),
          true,
          currentUsage(),
        ).catch(() => undefined);
      }
    } finally {
      clearInterval(heartbeatTimer);
      clearInterval(flushTimer);
      if (!settled && !entry.leaseLost) {
        await this.client
          .failJob(job.job_id, {
            failure_code: "worker_error",
            safe_message: "The worker stopped before this turn finished.",
            retryable: true,
            usage: currentUsage(),
          })
          .catch(() => undefined);
      }
      workspace?.dispose();
      this.active.delete(job.job_id);
    }
  }

  /**
   * Fold what the sandbox measured into what the event stream reported.
   *
   * The measured figures come from the host side of the model calls and cannot
   * be talked down by the code running inside the sandbox, so they are a floor
   * rather than an alternative. Taking the larger of the two also keeps an
   * honest runtime's finer-grained accounting -- it may know about tokens the
   * proxy could not read out of a response.
   */
  private mergeUsage(reported: UsageReport, measured: MeasuredUsage | undefined): UsageReport {
    const usage: UsageReport = { ...emptyUsage(), ...reported };
    if (!measured) return usage;
    usage.model_call_count = Math.max(usage.model_call_count, measured.model_call_count);
    usage.input_tokens = Math.max(usage.input_tokens, measured.input_tokens);
    usage.output_tokens = Math.max(usage.output_tokens, measured.output_tokens);
    return usage;
  }

  /**
   * Attach a cost to the token counts.
   *
   * A local model has no marginal cost, and the honest number for it is zero,
   * not an estimate borrowed from a hosted model's price list. When the
   * operator has configured pricing -- because they are paying an API -- it is
   * applied; when they have not, ``pricing_complete`` goes false so the studio
   * can say "cost unknown" rather than invent one.
   */
  private priceUsage(
    observed: UsageReport,
    model: ModelConfig,
    record: Record<string, unknown>,
    measured: MeasuredUsage | undefined,
  ): UsageReport {
    const fromResult = record["usage"];
    const usage: UsageReport = { ...emptyUsage(), ...observed };
    if (fromResult && typeof fromResult === "object") {
      const source = fromResult as Record<string, unknown>;
      const pick = (key: string): number => {
        const value = source[key];
        return typeof value === "number" && Number.isFinite(value) && value >= 0
          ? Math.floor(value)
          : 0;
      };
      // The runner's own totals are authoritative for tokens; the event stream
      // may have coalesced usage updates away.
      usage.model_call_count = Math.max(usage.model_call_count, pick("model_call_count"));
      usage.input_tokens = Math.max(usage.input_tokens, pick("input_tokens"));
      usage.output_tokens = Math.max(usage.output_tokens, pick("output_tokens"));
    }
    const input = model.pricing.input_per_million_usd;
    const output = model.pricing.output_per_million_usd;
    if (input === null || input === undefined || output === null || output === undefined) {
      usage.cost_usd = 0;
      usage.pricing_complete = false;
      return usage;
    }
    // A call whose response declared no usage leaves a hole in the count, and a
    // priced hole is an understated bill. Say the total is incomplete rather
    // than filling it with an average.
    const hasUnmeasured = (measured?.unmeasured_calls ?? 0) > 0;
    const priced = input > 0 || output > 0;
    usage.cost_usd = Number(
      ((usage.input_tokens / 1_000_000) * input + (usage.output_tokens / 1_000_000) * output).toFixed(
        6,
      ),
    );
    usage.pricing_complete = !(hasUnmeasured && priced);
    return usage;
  }
}
