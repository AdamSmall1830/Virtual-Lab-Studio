/**
 * The doctor command.
 *
 * The operator is running this on their own machine, usually before they have
 * ever seen it work, with a GPU, a container engine, a model server and a
 * remote studio all in play. When a job fails at 2am the useful question is
 * which of those four is wrong, and a worker that only says "job failed" makes
 * that a guessing game.
 *
 * So each check is independent, each says what it actually tried, and the
 * summary distinguishes "this will not work" from "this will work but is not
 * what you probably wanted". The checks are also strictly read-only: no job is
 * leased, no enrollment is consumed, no tokens are spent. Running the doctor
 * must never change anything.
 */
import { StudioClient } from "./client.js";
import type { WorkerConfig } from "./config.js";
import { modelApiKey } from "./config.js";
import { ADAPTER_VERSION, PINNED_AGENT_VERSION, SUPPORTED_PROFILE } from "./protocol.js";
import { safeErrorMessage } from "./redact.js";
import type { JobSandbox } from "./sandbox/types.js";

export type CheckState = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
}

async function checkModel(
  config: WorkerConfig,
  model: WorkerConfig["models"][number],
): Promise<CheckResult> {
  const name = `Model ${model.modelKey}`;
  const key = modelApiKey(model);
  if (model.apiKeyEnv && !key) {
    return {
      name,
      state: "fail",
      detail: `The configuration names ${model.apiKeyEnv} but that variable is not set.`,
      remedy: `Set ${model.apiKeyEnv} in the shell that starts the worker.`,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${model.baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        name,
        state: "fail",
        detail: `The model server answered ${response.status} for /models.`,
        remedy: "Check that the base URL points at an OpenAI-compatible endpoint.",
      };
    }
    const payload = (await response.json()) as { data?: { id?: string }[] };
    const ids = (payload.data ?? []).map((item) => item.id).filter(Boolean) as string[];
    if (ids.length > 0 && !ids.includes(model.providerModelId)) {
      return {
        name,
        state: "warn",
        detail: `The server is reachable but does not list ${model.providerModelId}.`,
        remedy: `Available: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", ..." : ""}. Pull the model or correct providerModelId.`,
      };
    }
    return { name, state: "pass", detail: `Reachable, serving ${model.providerModelId}.` };
  } catch (error) {
    return {
      name,
      state: "fail",
      detail: `Could not reach the model server: ${safeErrorMessage(error)}`,
      remedy: "Start the model server, or correct baseUrl in the configuration.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkStudio(config: WorkerConfig, token: string | null): Promise<CheckResult> {
  const name = "Virtual Lab Studio";
  if (!token) {
    return {
      name,
      state: "warn",
      detail: "Not enrolled yet, so the connection could not be authenticated.",
      remedy: "Run: vls-worker enroll --token <enrollment token from the studio>",
    };
  }
  const client = new StudioClient({
    baseUrl: config.serverUrl,
    token,
    userAgent: `vls-bridge-worker/${ADAPTER_VERSION}`,
  });
  try {
    // A heartbeat with no slots available is the read-only way to prove the
    // credential works: the server updates liveness but cannot hand back a job.
    const response = await client.heartbeat({
      adapter_version: ADAPTER_VERSION,
      prime_agent_version: PINNED_AGENT_VERSION,
      sandbox_mode: config.sandbox.kind === "container" ? "docker" : "process",
      capabilities: {
        profiles: [SUPPORTED_PROFILE],
        max_depth: 2,
        max_children: 8,
        python: true,
        web: false,
      },
      model_catalog: [],
      active_job_ids: [],
      capacity: { max_concurrent_jobs: config.concurrency, available_slots: 0 },
      health: { prime_agent: "ok", sandbox: "ok", models: "ok", safe_message: null },
    });
    return {
      name,
      state: "pass",
      detail: `Connected. The studio reports this worker as ${response.status}.`,
    };
  } catch (error) {
    return {
      name,
      state: "fail",
      detail: `Could not reach the studio: ${safeErrorMessage(error)}`,
      remedy:
        "Check serverUrl, and that the worker is still enabled on the studio's Recursive agents page.",
    };
  }
}

export async function runDoctor(
  config: WorkerConfig,
  sandbox: JobSandbox,
  token: string | null,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push({
    name: "Configuration",
    state: "pass",
    detail: `${config.models.length} model${config.models.length === 1 ? "" : "s"}, concurrency ${config.concurrency}, sandbox ${config.sandbox.kind}.`,
  });

  const sandboxCheck = await sandbox.preflight();
  if (sandbox.mode === "process") {
    results.push({
      name: "Sandbox",
      state: "warn",
      detail: sandboxCheck.detail,
      remedy:
        'Use sandbox.kind "container" for any real research. The process runner gives model-generated code your own permissions.',
    });
  } else {
    results.push({
      name: "Sandbox",
      state: sandboxCheck.ok ? "pass" : "fail",
      detail: sandboxCheck.detail,
      ...(sandboxCheck.ok
        ? {}
        : { remedy: "Start the container engine and build docker/Dockerfile." }),
    });
  }

  const modelChecks = await Promise.all(config.models.map((model) => checkModel(config, model)));
  results.push(...modelChecks);
  results.push(await checkStudio(config, token));

  return results;
}

export function formatDoctor(results: CheckResult[]): string {
  const symbol: Record<CheckState, string> = { pass: "OK  ", warn: "WARN", fail: "FAIL" };
  const lines = results.map((result) => {
    const head = `${symbol[result.state]}  ${result.name}: ${result.detail}`;
    return result.remedy ? `${head}\n        -> ${result.remedy}` : head;
  });
  const failures = results.filter((result) => result.state === "fail").length;
  const warnings = results.filter((result) => result.state === "warn").length;
  lines.push("");
  if (failures > 0) {
    lines.push(
      `${failures} check${failures === 1 ? "" : "s"} failed. The worker will not be able to run jobs until they pass.`,
    );
  } else if (warnings > 0) {
    lines.push(`Ready, with ${warnings} warning${warnings === 1 ? "" : "s"} worth reading above.`);
  } else {
    lines.push("Everything checks out. Start the worker with: vls-worker run");
  }
  return lines.join("\n");
}
