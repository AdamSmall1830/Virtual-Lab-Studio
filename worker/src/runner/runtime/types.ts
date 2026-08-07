/**
 * The agent runtime interface.
 *
 * Two implementations sit behind this: the Prime Agent SDK (what a real run
 * uses) and a fake used by the tests and by demo mode. There is deliberately no
 * third "degraded but still real" runtime. The agent's CLI can be driven over
 * its JSON-lines RPC mode, but it has no way to register this worker's reviewed
 * in-process tools, so a participant run there would be offered the agent's own
 * file and shell tools instead. A fallback that quietly changes what a research
 * participant can do to the operator's machine is worse than no fallback: if
 * the SDK cannot be configured, the job fails and says why.
 *
 * What the interface deliberately does *not* expose is any way to add a tool,
 * load a skill, or change the system prompt from outside: the session's shape
 * is decided by the entrypoint and is the same for every run.
 */

/**
 * Raised when a participant was stopped because it hit the meeting's turn
 * ceiling.
 *
 * This is an error rather than a truncated return value on purpose. A run that
 * was cut off mid-argument has not answered the question, and the text it had
 * produced by then reads exactly like a finished answer -- so returning it lets
 * a bounded-out run be published as a completed research result. Failing here
 * makes the host report the breach instead.
 */
export class AgentLimitExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLimitExceeded";
  }
}

export interface RuntimeToolCall {
  name: string;
  input: unknown;
}

export interface RuntimeToolResult {
  content: string;
  isError?: boolean;
}

export interface RuntimeTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  handler: (input: unknown) => Promise<RuntimeToolResult>;
}

export interface RuntimeUsage {
  model_call_count: number;
  input_tokens: number;
  output_tokens: number;
}

export interface RuntimeObserver {
  onAssistantText?: (text: string) => void;
  onToolStart?: (call: RuntimeToolCall) => void;
  onToolEnd?: (call: RuntimeToolCall, result: RuntimeToolResult) => void;
  onUsage?: (usage: RuntimeUsage) => void;
}

export interface RuntimeSessionOptions {
  /** The provider model id, as the local server names it. */
  model: string;
  /** OpenAI-compatible base URL. Always the sandbox-side proxy address. */
  baseUrl: string;
  /** The model's context window, as configured by the operator. */
  contextWindow: number;
  /** The most output tokens one call may ask for. Matches the proxy's ceiling. */
  maxOutputTokens: number;
  /** Name of the environment variable holding the proxy's job token. */
  apiKeyEnv: string;
  systemPrompt: string;
  tools: RuntimeTool[];
  maxTurns: number;
  cwd: string;
  /** Where a transient agent directory may live; always inside the sandbox. */
  agentDir: string;
}

export interface RuntimeSession {
  /** Send one prompt and run to completion, returning the assistant's text. */
  prompt(text: string, observer: RuntimeObserver): Promise<string>;
  usage(): RuntimeUsage;
  abort(): void;
  dispose(): Promise<void>;
}

export interface AgentRuntime {
  readonly id: "sdk" | "fake";
  /** Reported to the studio so a simulated run can never be mistaken for real. */
  readonly isSimulation: boolean;
  readonly version: string | null;
  createSession(options: RuntimeSessionOptions): Promise<RuntimeSession>;
}
