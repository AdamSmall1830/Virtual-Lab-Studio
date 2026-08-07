/**
 * Operator configuration.
 *
 * Three properties matter more than convenience here.
 *
 * *An unconfigured worker must not start.* The shipped example file is full of
 * ``<REPLACE_ME>`` placeholders. If one survives into a loaded config the load
 * fails, naming the field. A worker that silently started with a placeholder
 * model endpoint would enroll, advertise a model catalogue, win a job and then
 * fail it -- and the researcher would see a broken participant rather than an
 * unconfigured machine.
 *
 * *Credentials never live in the config file.* The config names an environment
 * variable to read the model API key from; the worker credential is written to
 * its own file with owner-only permissions. Config files get committed to
 * dotfile repositories and pasted into support threads.
 *
 * *The defaults are the safe ones.* Concurrency is 1, the sandbox is a
 * container, and the process runner has to be asked for twice.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { ModelPricing } from "./protocol.js";

/** The tag the example config uses everywhere a real value is required. */
export const PLACEHOLDER_TAG = "<REPLACE_ME>";

/**
 * Matches the bare tag and the annotated form the example config uses --
 * ``<REPLACE_ME: http://127.0.0.1:11434/v1>`` -- because the annotation is what
 * makes the example readable, and a detector that only knew the bare tag would
 * wave the entire example file through.
 */
const PLACEHOLDER_PATTERN = /<REPLACE_ME\b[^>]*>/;

export type SandboxKind = "container" | "process";
export type AgentRuntimeKind = "auto" | "sdk" | "fake";
export type NetworkMode = "proxy" | "none";

export interface ModelConfig {
  /** The key the researcher selects in the studio. Free-form but stable. */
  modelKey: string;
  displayName: string;
  /** OpenAI-compatible chat-completions base, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** The model id the server above expects, if it differs from modelKey. */
  providerModelId: string;
  /** Name of the environment variable holding the key. Never the key itself. */
  apiKeyEnv: string | null;
  contextWindow: number;
  maxTokens: number;
  supportsTools: boolean;
  /** Advertised so the studio can show a truthful cost of zero for local runs. */
  pricing: ModelPricing;
}

export interface SandboxConfig {
  kind: SandboxKind;
  /** ``docker`` or ``podman``. Anything else is rejected at load. */
  engine: string;
  image: string;
  network: NetworkMode;
  memory: string;
  cpus: string;
  pidsLimit: number;
  /** Hard ceiling regardless of what a job asks for. */
  maxRuntimeSecondsCeiling: number;
  /**
   * Running the agent as a plain host process gives model-generated Python the
   * operator's own permissions. It exists for developing this worker and is
   * refused outside development; see sandbox/process.ts.
   */
  allowUnsafeProcessRunner: boolean;
}

export interface WorkerConfig {
  serverUrl: string;
  displayName: string;
  concurrency: number;
  agentRuntime: AgentRuntimeKind;
  workspaceRoot: string;
  workerTokenFile: string;
  sandbox: SandboxConfig;
  models: ModelConfig[];
  /** Resolved absolute path of the file this came from, for diagnostics. */
  configPath: string;
}

export class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

function assertNoPlaceholder(value: unknown, path: string): void {
  if (typeof value === "string" && PLACEHOLDER_PATTERN.test(value)) {
    fail(
      `${path} still contains ${PLACEHOLDER_TAG}. Fill it in before starting the worker.`,
    );
  }
}

function walkForPlaceholders(node: unknown, path: string): void {
  assertNoPlaceholder(node, path);
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkForPlaceholders(item, `${path}[${index}]`));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      // JSON has no comments, so the example file explains itself in "_"-prefixed
      // keys -- and that prose mentions the placeholder tag. Reporting the
      // documentation instead of the field that needs filling in would send the
      // operator to the wrong line.
      if (key.startsWith("_")) continue;
      walkForPlaceholders(value, path ? `${path}.${key}` : key);
    }
  }
}

function str(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optStr(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: string | null,
): string | null {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") fail(`${path}.${key} must be a string when present.`);
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function num(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path}.${key} must be a number.`);
  }
  if (value < min || value > max) {
    fail(`${path}.${key} must be between ${min} and ${max}.`);
  }
  return value;
}

function bool(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") fail(`${path}.${key} must be true or false.`);
  return value;
}

function obj(source: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = source[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    fail(`${path}.${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parsePricing(source: Record<string, unknown>, path: string): ModelPricing {
  const raw = obj(source, "pricing", path);
  const input = raw["input_per_million_usd"] ?? raw["inputPerMillionUsd"];
  const output = raw["output_per_million_usd"] ?? raw["outputPerMillionUsd"];
  const numberOrNull = (value: unknown, field: string): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(`${path}.pricing.${field} must be a non-negative number when present.`);
    }
    return value;
  };
  return {
    input_per_million_usd: numberOrNull(input, "input_per_million_usd"),
    output_per_million_usd: numberOrNull(output, "output_per_million_usd"),
    currency: typeof raw["currency"] === "string" ? (raw["currency"] as string) : "USD",
  };
}

function parseModel(raw: unknown, index: number): ModelConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`models[${index}] must be an object.`);
  }
  const source = raw as Record<string, unknown>;
  const path = `models[${index}]`;
  const modelKey = str(source, "modelKey", path);
  const baseUrl = str(source, "baseUrl", path);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return fail(`${path}.baseUrl is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`${path}.baseUrl must be http or https.`);
  }
  if (parsed.username || parsed.password) {
    fail(`${path}.baseUrl must not embed credentials. Use apiKeyEnv instead.`);
  }
  return {
    modelKey,
    displayName: optStr(source, "displayName", path, null) ?? modelKey,
    baseUrl: parsed.toString().replace(/\/$/, ""),
    providerModelId: optStr(source, "providerModelId", path, null) ?? modelKey,
    apiKeyEnv: optStr(source, "apiKeyEnv", path, null),
    contextWindow: num(source, "contextWindow", path, 128_000, 1_024, 100_000_000),
    maxTokens: num(source, "maxTokens", path, 8_192, 256, 1_000_000),
    supportsTools: bool(source, "supportsTools", path, true),
    pricing: parsePricing(source, path),
  };
}

function parseSandbox(source: Record<string, unknown>): SandboxConfig {
  const raw = obj(source, "sandbox", "");
  const kindRaw = optStr(raw, "kind", "sandbox", "container");
  if (kindRaw !== "container" && kindRaw !== "process") {
    fail(`sandbox.kind must be "container" or "process".`);
  }
  const engine = optStr(raw, "engine", "sandbox", "docker") ?? "docker";
  if (engine !== "docker" && engine !== "podman") {
    fail(`sandbox.engine must be "docker" or "podman".`);
  }
  const network = optStr(raw, "network", "sandbox", "proxy");
  if (network !== "proxy" && network !== "none") {
    fail(`sandbox.network must be "proxy" or "none".`);
  }
  return {
    kind: kindRaw,
    engine,
    image: optStr(raw, "image", "sandbox", null) ?? "vls-bridge-runner:0.1.0",
    network,
    memory: optStr(raw, "memory", "sandbox", null) ?? "4g",
    cpus: optStr(raw, "cpus", "sandbox", null) ?? "2",
    pidsLimit: num(raw, "pidsLimit", "sandbox", 256, 16, 4_096),
    maxRuntimeSecondsCeiling: num(
      raw,
      "maxRuntimeSecondsCeiling",
      "sandbox",
      3_600,
      60,
      86_400,
    ),
    allowUnsafeProcessRunner: bool(raw, "allowUnsafeProcessRunner", "sandbox", false),
  };
}

export function parseConfig(raw: unknown, configPath: string): WorkerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("The configuration file must contain a JSON object.");
  }
  walkForPlaceholders(raw, "");
  const source = raw as Record<string, unknown>;

  const serverUrl = str(source, "serverUrl", "");
  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    return fail("serverUrl is not a valid URL.");
  }
  if (server.protocol !== "https:" && server.hostname !== "localhost" && server.hostname !== "127.0.0.1") {
    fail(
      "serverUrl must use https. Plain http is allowed only for localhost while developing.",
    );
  }

  const runtimeRaw = optStr(source, "agentRuntime", "", "auto") ?? "auto";
  if (!["auto", "sdk", "fake"].includes(runtimeRaw)) {
    fail(`agentRuntime must be one of auto, sdk, fake.`);
  }

  const modelsRaw = source["models"];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    fail("models must be a non-empty array. The worker has nothing to offer without one.");
  }
  const models = modelsRaw.map(parseModel);
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.modelKey)) {
      fail(`models contains ${model.modelKey} more than once.`);
    }
    seen.add(model.modelKey);
  }

  const base = resolve(configPath, "..");
  const resolveFromConfig = (value: string): string =>
    isAbsolute(value) ? value : resolve(base, value);

  return {
    serverUrl: server.toString().replace(/\/$/, ""),
    displayName: optStr(source, "displayName", "", null) ?? "Bridge worker",
    concurrency: num(source, "concurrency", "", 1, 1, 8),
    agentRuntime: runtimeRaw as AgentRuntimeKind,
    workspaceRoot: resolveFromConfig(
      optStr(source, "workspaceRoot", "", null) ?? ".vls/jobs",
    ),
    workerTokenFile: resolveFromConfig(
      optStr(source, "workerTokenFile", "", null) ?? ".vls/worker-token",
    ),
    sandbox: parseSandbox(source),
    models,
    configPath,
  };
}

export function defaultConfigPath(): string {
  return resolve(process.env["VLS_WORKER_CONFIG"] ?? "worker.config.json");
}

export function loadConfig(configPath = defaultConfigPath()): WorkerConfig {
  let text: string;
  try {
    statSync(configPath);
    text = readFileSync(configPath, "utf8");
  } catch {
    throw new ConfigError(
      `No configuration file at ${configPath}. Copy worker.config.example.json and fill it in.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${configPath} is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
    );
  }
  return parseConfig(parsed, configPath);
}

/**
 * Resolve a model's API key from the environment at the moment of use.
 *
 * Read late and never cached, so rotating the key means restarting nothing but
 * the shell, and so the value spends as little time in this process as
 * possible.
 */
export function modelApiKey(model: ModelConfig): string | null {
  if (!model.apiKeyEnv) return null;
  const value = process.env[model.apiKeyEnv];
  return value && value.trim() !== "" ? value : null;
}
