/**
 * The fake runtime.
 *
 * Used by the unit tests and by ``--runtime fake``, which lets an operator
 * exercise the whole path -- lease, bundle, sandbox, events, validation,
 * submission -- without a model server.
 *
 * It advertises ``isSimulation: true``, and that flag rides all the way to the
 * server's ``is_simulation`` field and into the studio's UI. A simulated turn
 * must be labelled as one everywhere it appears; a research record that cannot
 * distinguish a real model's answer from a scripted one is worthless.
 *
 * The script is intentionally faithful to the contract rather than to any
 * particular model: it calls the evidence tool, cites what it finds, and
 * produces a result the validator accepts. Tests that need a hostile runtime
 * override the script.
 */
import type {
  AgentRuntime,
  RuntimeObserver,
  RuntimeSession,
  RuntimeSessionOptions,
  RuntimeUsage,
} from "./types.js";

export type FakeScript = (
  prompt: string,
  tools: RuntimeSessionOptions["tools"],
  observer: RuntimeObserver,
) => Promise<string>;

const DEFAULT_SCRIPT: FakeScript = async (_prompt, tools, observer) => {
  const evidence = tools.find((tool) => tool.name === "evidence_search");
  let cited = "";
  if (evidence) {
    const call = { name: evidence.name, input: { command: "list" } };
    observer.onToolStart?.(call);
    const result = await evidence.handler(call.input);
    observer.onToolEnd?.(call, result);
    try {
      const parsed = JSON.parse(result.content) as { evidence?: { evidence_key?: string }[] };
      cited = parsed.evidence?.[0]?.evidence_key ?? "";
    } catch {
      cited = "";
    }
  }
  const text =
    "This is a simulated participant response produced without a language model. " +
    (cited
      ? `It reviewed the attached evidence and would cite ${cited}.`
      : "No evidence was attached to this meeting.");
  observer.onAssistantText?.(text);
  observer.onUsage?.({ model_call_count: 1, input_tokens: 120, output_tokens: 60 });
  return text;
};

export class FakeRuntime implements AgentRuntime {
  readonly id = "fake" as const;
  readonly isSimulation = true;
  readonly version = null;

  constructor(private readonly script: FakeScript = DEFAULT_SCRIPT) {}

  async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const totals: RuntimeUsage = { model_call_count: 0, input_tokens: 0, output_tokens: 0 };
    let aborted = false;
    const script = this.script;
    return {
      async prompt(text: string, observer: RuntimeObserver): Promise<string> {
        if (aborted) throw new Error("The session was aborted.");
        const wrapped: RuntimeObserver = {
          ...observer,
          onUsage(usage) {
            totals.model_call_count += usage.model_call_count;
            totals.input_tokens += usage.input_tokens;
            totals.output_tokens += usage.output_tokens;
            observer.onUsage?.(usage);
          },
        };
        return script(text, options.tools, wrapped);
      },
      usage: () => ({ ...totals }),
      abort(): void {
        aborted = true;
      },
      async dispose(): Promise<void> {
        /* nothing to release */
      },
    };
  }
}
