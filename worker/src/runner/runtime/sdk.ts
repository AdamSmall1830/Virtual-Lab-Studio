/**
 * The Prime Agent SDK adapter -- the production path.
 *
 * The SDK is an *optional* dependency, pinned to one exact version. Optional
 * because the worker must install, typecheck and test on a machine that will
 * never run a job (CI, a reviewer's laptop); pinned because this adapter drives
 * a specific published surface and a floating range would let an upstream
 * release silently change how a research participant behaves.
 *
 * The import is therefore dynamic and feature-checked. If the module is absent,
 * or its exports have moved, or the model cannot be registered, this adapter
 * refuses with a message naming the pinned version rather than half-configuring
 * a session. There is nothing to fall back to, which is the point: every
 * property below is load-bearing, and a "degraded" real run would be a run
 * whose restrictions nobody had checked.
 *
 * Session shape is the security-relevant part:
 *
 * * ``noTools: "all"`` starts with nothing enabled and ``tools`` then names
 *   only the reviewed tools built in tools.ts. ``excludeTools`` re-states the
 *   built-in file and shell tools as a denylist, which the SDK applies *after*
 *   the allowlist, so a future SDK release that changed allowlist semantics
 *   would still not hand a participant a ``bash``.
 * * ``sessionManager`` is in-memory. Nothing is written to a session store, so
 *   one turn cannot read another's history, and the operator's own agent
 *   history is never in scope.
 * * The ``ResourceLoader`` is constructed explicitly with extensions, skills,
 *   prompt templates, themes and context files all switched off, and with the
 *   system prompt supplied by the meeting definition. Combined with an
 *   ``agentDir`` inside the sandbox, that is how the operator's real ``~/.pi``
 *   -- their extensions, skills, memories and past conversations -- stays out
 *   of the run. A participant's behaviour must come from the meeting, not from
 *   whatever the operator happens to have installed.
 * * The model is a provider registered on a throwaway ``ModelRuntime`` that
 *   points at the sandbox-side proxy and nothing else, with ``modelsPath: null``
 *   so no ``models.json`` on the operator's disk can add a second endpoint, and
 *   ``allowModelNetwork: false`` so creating the runtime cannot reach out.
 * * The model credential is read from an environment variable and installed as
 *   a *runtime* key, which the SDK keeps in memory and never persists. It is
 *   never a command-line argument, because argv is visible to every process on
 *   the machine.
 *
 * The SDK has no turn ceiling of its own, so this adapter counts ``turn_start``
 * events and aborts the session on the turn after the limit. That is a real
 * stop, not a request, and it is reported as a failure rather than returned as
 * an answer -- see ``AgentLimitExceeded``.
 */
import { PINNED_AGENT_VERSION } from "../../protocol.js";
import { AgentLimitExceeded } from "./types.js";
import type {
  AgentRuntime,
  RuntimeObserver,
  RuntimeSession,
  RuntimeSessionOptions,
  RuntimeUsage,
} from "./types.js";

export class SdkUnavailable extends Error {}

/**
 * The provider id the sandbox-side proxy is registered under. Deliberately not
 * "openai" or any other built-in id: overriding a built-in would inherit its
 * environment-variable auth and its model catalogue.
 */
const PROVIDER_ID = "vls_local";

interface SdkSession {
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

interface SdkModelRuntime {
  registerProvider(providerId: string, config: Record<string, unknown>): void;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  getModel(providerId: string, modelId: string): unknown;
}

interface SdkResourceLoader {
  reload(): Promise<unknown>;
}

interface SdkModule {
  createAgentSession: (options: Record<string, unknown>) => Promise<{ session: SdkSession }>;
  createAgentSessionRuntime?: unknown;
  SessionManager: { inMemory: (cwd?: string) => unknown };
  SettingsManager: { inMemory: (settings?: Record<string, unknown>) => unknown };
  ModelRuntime: { create: (options?: Record<string, unknown>) => Promise<SdkModelRuntime> };
  DefaultResourceLoader: new (options: Record<string, unknown>) => SdkResourceLoader;
  defineTool: (definition: Record<string, unknown>) => unknown;
  VERSION?: string;
}

function hasFunction(value: unknown, key: string): boolean {
  return Boolean(value) && typeof (value as Record<string, unknown>)[key] === "function";
}

/**
 * Every export this adapter calls, with the shape it calls it in. Checked up
 * front so a surface change produces one clear refusal naming the pinned
 * version, instead of a TypeError deep inside a run.
 */
const REQUIRED_EXPORTS: Array<{ name: string; methods?: string[]; construct?: boolean }> = [
  { name: "createAgentSession" },
  { name: "defineTool" },
  { name: "SessionManager", methods: ["inMemory"] },
  { name: "SettingsManager", methods: ["inMemory"] },
  { name: "ModelRuntime", methods: ["create"] },
  { name: "DefaultResourceLoader", construct: true },
];

async function importSdk(): Promise<SdkModule> {
  let module: Record<string, unknown>;
  try {
    // The specifier is built at runtime so bundlers do not try to resolve an
    // optional dependency that is legitimately absent.
    const specifier = ["@earendil-works", "pi-coding-agent"].join("/");
    module = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    throw new SdkUnavailable(
      `The Prime Agent SDK (${PINNED_AGENT_VERSION}) is not installed in this sandbox, ` +
        "so no real participant can run. Rebuild the runner image (docker build -f docker/Dockerfile), " +
        `or install it in the worker directory with npm install. (${
          error instanceof Error ? error.message : "import failed"
        })`,
    );
  }
  for (const required of REQUIRED_EXPORTS) {
    const value = module[required.name];
    if (value === undefined) {
      throw new SdkUnavailable(
        `The installed Prime Agent SDK does not export ${required.name}. This worker is built against ${PINNED_AGENT_VERSION}.`,
      );
    }
    if (required.construct && typeof value !== "function") {
      throw new SdkUnavailable(
        `The installed Prime Agent SDK exports ${required.name} but it is not constructible. This worker is built against ${PINNED_AGENT_VERSION}.`,
      );
    }
    for (const method of required.methods ?? []) {
      if (!hasFunction(value, method)) {
        throw new SdkUnavailable(
          `The installed Prime Agent SDK's ${required.name} has no ${method}(). This worker is built against ${PINNED_AGENT_VERSION}.`,
        );
      }
    }
  }
  return module as unknown as SdkModule;
}

/**
 * Built-ins re-stated as a denylist. The allowlist already excludes them; this
 * is the second lock, and it is cheap.
 */
const EXCLUDED_BUILTINS = [
  "bash",
  "read",
  "write",
  "edit",
  "multi_edit",
  "grep",
  "find",
  "ls",
  "glob",
  "web_search",
  "web_fetch",
  "fetch",
  "task",
  "todo_write",
  "ask_question",
];

/** The tool names this adapter is willing to enable, for the record. */
export function enabledToolNames(options: RuntimeSessionOptions): string[] {
  return options.tools.map((tool) => tool.name);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    if (value && typeof value === "object") {
      const content = (value as Record<string, unknown>)["content"];
      if (content !== undefined && content !== value) return textOf(content);
    }
    return "";
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"] as string);
    }
  }
  return parts.join("");
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Read one assistant message's usage. pi-ai reports `input`/`output` on every
 * assistant message; the host's proxy meters the same traffic independently,
 * so this is the runtime's own account of what it spent, not the authority.
 */
function readUsageFrom(message: unknown): RuntimeUsage | null {
  if (!message || typeof message !== "object") return null;
  const usage = (message as Record<string, unknown>)["usage"];
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  return {
    model_call_count: 1,
    input_tokens: nonNegative(record["input"]) + nonNegative(record["cacheRead"]) + nonNegative(record["cacheWrite"]),
    output_tokens: nonNegative(record["output"]),
  };
}

export class SdkRuntime implements AgentRuntime {
  readonly id = "sdk" as const;
  readonly isSimulation = false;
  readonly version = PINNED_AGENT_VERSION;

  static async probe(): Promise<boolean> {
    try {
      await importSdk();
      return true;
    } catch {
      return false;
    }
  }

  async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const sdk = await importSdk();

    const apiKey = process.env[options.apiKeyEnv];
    if (!apiKey) {
      throw new SdkUnavailable(
        `The model credential is missing: ${options.apiKeyEnv} is not set in the sandbox.`,
      );
    }

    // A runtime of our own: no models.json from the operator's disk, an
    // auth file inside the throwaway agent directory, and no network.
    let modelRuntime: SdkModelRuntime;
    try {
      modelRuntime = await sdk.ModelRuntime.create({
        authPath: `${options.agentDir}/auth.json`,
        modelsPath: null,
        allowModelNetwork: false,
      });
    } catch (error) {
      throw new SdkUnavailable(
        `The Prime Agent SDK could not start a model runtime: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "Virtual Lab local model",
      baseUrl: options.baseUrl,
      api: "openai-completions",
      models: [
        {
          id: options.model,
          name: options.model,
          reasoning: false,
          input: ["text"],
          // Local inference is free to run; the studio prices a run from its
          // own table, so a fabricated number here would only mislead.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: options.contextWindow,
          maxTokens: options.maxOutputTokens,
          compat: {
            // llama.cpp, Ollama, vLLM and friends reject both of these.
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
        },
      ],
    });

    // A runtime key: held in memory by the SDK, never written to auth.json.
    await modelRuntime.setRuntimeApiKey(PROVIDER_ID, apiKey);

    const model = modelRuntime.getModel(PROVIDER_ID, options.model);
    if (!model) {
      throw new SdkUnavailable(
        `The Prime Agent SDK did not accept the model registration for ${options.model}.`,
      );
    }

    const settingsManager = sdk.SettingsManager.inMemory({
      // Compaction is a model call the host did not authorise and cannot
      // predict. A participant that runs out of context fails visibly.
      compaction: { enabled: false },
    });

    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      systemPrompt: options.systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const toolNames = enabledToolNames(options);
    const customTools = options.tools.map((tool) =>
      sdk.defineTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        // TypeBox schemas are plain JSON Schema objects at runtime; the tool
        // definitions in tools.ts are written as JSON Schema for exactly this
        // reason, so the SDK is not required to build them.
        parameters: tool.parameters,
        execute: async (_toolCallId: string, params: unknown) => {
          const result = await tool.handler(params);
          if (result.isError) {
            // The agent loop turns a throw into an error tool result, which is
            // what the model needs to see. There is no isError on the success
            // shape to set instead.
            throw new Error(result.content);
          }
          return { content: [{ type: "text", text: result.content }], details: {} };
        },
      }),
    );

    let created: { session: SdkSession };
    try {
      created = await sdk.createAgentSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "off",
        noTools: "all",
        tools: toolNames,
        excludeTools: EXCLUDED_BUILTINS,
        customTools,
        resourceLoader,
        sessionManager: sdk.SessionManager.inMemory(options.cwd),
        settingsManager,
      });
    } catch (error) {
      throw new SdkUnavailable(
        `The Prime Agent SDK could not create a session: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    const session = created?.session;
    if (!session || !hasFunction(session, "prompt") || !hasFunction(session, "subscribe")) {
      throw new SdkUnavailable("The Prime Agent SDK returned a session without prompt/subscribe.");
    }

    const totals: RuntimeUsage = { model_call_count: 0, input_tokens: 0, output_tokens: 0 };
    const maxTurns = Math.max(1, Math.floor(options.maxTurns));

    return {
      async prompt(text: string, observer: RuntimeObserver): Promise<string> {
        let streamed = "";
        let lastTurnText = "";
        let turns = 0;
        let stoppedAtLimit = false;
        const toolCalls = new Map<string, { name: string; input: unknown }>();

        const unsubscribe = session.subscribe((event: Record<string, unknown>) => {
          switch (event["type"]) {
            case "turn_start": {
              turns += 1;
              if (turns > maxTurns) {
                stoppedAtLimit = true;
                void session.abort();
              }
              break;
            }
            case "message_update": {
              const inner = event["assistantMessageEvent"];
              if (inner && typeof inner === "object") {
                const record = inner as Record<string, unknown>;
                if (record["type"] === "text_delta" && typeof record["delta"] === "string") {
                  streamed += record["delta"];
                }
              }
              break;
            }
            case "tool_execution_start": {
              const call = {
                name: String(event["toolName"] ?? "tool"),
                input: event["args"],
              };
              const id = event["toolCallId"];
              if (typeof id === "string") toolCalls.set(id, call);
              observer.onToolStart?.(call);
              break;
            }
            case "tool_execution_end": {
              const id = event["toolCallId"];
              const call =
                (typeof id === "string" ? toolCalls.get(id) : undefined) ??
                { name: String(event["toolName"] ?? "tool"), input: undefined };
              if (typeof id === "string") toolCalls.delete(id);
              observer.onToolEnd?.(call, {
                content: textOf(event["result"]),
                isError: event["isError"] === true,
              });
              break;
            }
            case "turn_end": {
              const message = event["message"];
              const usage = readUsageFrom(message);
              if (usage) {
                totals.model_call_count += usage.model_call_count;
                totals.input_tokens += usage.input_tokens;
                totals.output_tokens += usage.output_tokens;
                observer.onUsage?.(usage);
              }
              const text = textOf(
                message && typeof message === "object"
                  ? (message as Record<string, unknown>)["content"]
                  : undefined,
              );
              if (text.trim()) lastTurnText = text;
              break;
            }
            default:
              break;
          }
        });

        try {
          await session.prompt(text);
        } finally {
          unsubscribe();
        }

        if (stoppedAtLimit) {
          // Whatever the participant had written by now is an interrupted train
          // of thought, and it is not passed on: text that stops mid-argument
          // reads like a conclusion, and the host cannot tell the difference.
          throw new AgentLimitExceeded(
            `The participant reached its ${maxTurns}-turn limit and was stopped before it answered.`,
          );
        }

        const answer = lastTurnText.trim() ? lastTurnText : streamed;
        if (answer.trim()) observer.onAssistantText?.(answer);
        return answer;
      },
      usage: () => ({ ...totals }),
      abort(): void {
        void session.abort().catch(() => undefined);
      },
      async dispose(): Promise<void> {
        session.dispose();
      },
    };
  }
}
