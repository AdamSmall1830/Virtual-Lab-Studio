/**
 * The line protocol between the sandbox and this worker.
 *
 * The runner inside the container emits one JSON object per line on stdout,
 * each prefixed with a sentinel. Everything without the sentinel is treated as
 * diagnostic noise -- npm banners, provider warnings, a Python traceback -- and
 * is never forwarded upstream. That inversion matters: the default for output
 * crossing the sandbox boundary is "drop", and only a deliberately framed,
 * schema-checked line escapes it.
 *
 * These are the runtime's own vocabulary, not the server's. Mapping one onto
 * the other happens in events.ts, which is also where the host-side bounds and
 * redaction live -- inside the sandbox none of that can be trusted.
 */

export const RUNNER_LINE_PREFIX = "@@VLS@@ ";

export type RunnerEvent =
  | { kind: "runner.ready"; adapter: string; prime_agent_version: string | null }
  | { kind: "node.started"; node_id: string; parent_node_id: string | null; display_name: string; task_summary?: string; model_key?: string; depth: number }
  | { kind: "node.progress"; node_id: string; task_summary?: string; result_summary?: string }
  | { kind: "node.completed"; node_id: string; result_summary?: string; cited_evidence_keys?: string[] }
  | { kind: "node.failed"; node_id: string; failure_category?: string; message?: string }
  | { kind: "tool.started"; node_id: string; tool: string }
  | { kind: "tool.completed"; node_id: string; tool: string }
  | { kind: "tool.failed"; node_id: string; tool: string; message?: string }
  | {
      kind: "usage";
      node_id: string | null;
      model_call_count: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      pricing_complete: boolean;
    }
  | { kind: "diagnostic"; level: "debug" | "info" | "warn" | "error"; message: string };

/** Frame a runner event for stdout. */
export function encodeRunnerEvent(event: RunnerEvent): string {
  return `${RUNNER_LINE_PREFIX}${JSON.stringify(event)}\n`;
}

/**
 * Parse a line of sandbox stdout.
 *
 * Returns ``null`` for anything that is not a well-formed framed event. The
 * checks are structural rather than exhaustive: events.ts re-validates every
 * field it uses, because a compromised runner controls this entire stream.
 */
export function decodeRunnerLine(line: string): RunnerEvent | null {
  if (!line.startsWith(RUNNER_LINE_PREFIX)) return null;
  const body = line.slice(RUNNER_LINE_PREFIX.length).trim();
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const kind = (parsed as Record<string, unknown>)["kind"];
  if (typeof kind !== "string") return null;
  return parsed as RunnerEvent;
}

/**
 * Split a byte stream into lines without unbounded buffering.
 *
 * A runner that never emits a newline would otherwise grow this buffer until
 * the worker died. Over-long lines are discarded up to the next newline: a
 * single event is not worth an out-of-memory kill, and dropping it is visible
 * in the sequence numbers.
 */
export class LineSplitter {
  private buffer = "";

  constructor(private readonly maxLineLength = 256 * 1024) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxLineLength) {
      this.buffer = "";
      lines.push("");
    }
    return lines;
  }

  flush(): string[] {
    if (!this.buffer) return [];
    const line = this.buffer;
    this.buffer = "";
    return [line];
  }
}
