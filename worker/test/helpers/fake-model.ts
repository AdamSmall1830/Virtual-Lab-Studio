/**
 * A scripted OpenAI-compatible model server.
 *
 * Stands in for the operator's Ollama / llama.cpp / vLLM endpoint so the tests
 * that drive the real Prime Agent SDK are deterministic and need no GPU. It
 * speaks streamed chat completions, because that is what the agent asks for,
 * and it records every request so a test can assert what the model was actually
 * offered -- the tool list, the system prompt, the bearer token -- rather than
 * asserting the adapter's intentions from its own source.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One scripted assistant turn. ``both`` is the interesting one: a model that
 * writes prose *and* calls a tool has produced answer-shaped text without
 * having finished, which is the case a turn cap has to get right.
 */
export type ScriptedTurn =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "both"; text: string; tool: string; args: Record<string, unknown> };

export interface ModelRequest {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function renderTurn(turn: ScriptedTurn, modelId: string): string[] {
  const base = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: modelId,
  };
  const delta: Record<string, unknown> = { role: "assistant" };
  if (turn.kind === "text" || turn.kind === "both") delta["content"] = turn.text;
  if (turn.kind === "tool" || turn.kind === "both") {
    delta["tool_calls"] = [
      {
        index: 0,
        id: `call_${turn.tool}`,
        type: "function",
        function: { name: turn.tool, arguments: JSON.stringify(turn.args) },
      },
    ];
  }
  return [
    sse({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }),
    // A chunk without a finish_reason makes the client throw, so every turn
    // ends with one -- the same contract a real server has to meet.
    sse({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: turn.kind === "text" ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 101, completion_tokens: 7, total_tokens: 108 },
    }),
    "data: [DONE]\n\n",
  ];
}

export class FakeModelServer {
  readonly requests: ModelRequest[] = [];
  private server: Server | null = null;
  private script: ScriptedTurn[] = [];
  /** Used once the script runs out, so a looping agent still gets replies. */
  private fallback: ScriptedTurn = { kind: "text", text: "Done." };
  port = 0;

  constructor(private readonly modelId = "vls-test-model") {}

  setScript(turns: ScriptedTurn[], fallback?: ScriptedTurn): void {
    this.script = [...turns];
    if (fallback) this.fallback = fallback;
    this.requests.length = 0;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** Reachable from another container on the same host. */
  get hostBaseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(host = "127.0.0.1"): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        } catch {
          body = {};
        }
        this.requests.push({
          path: req.url ?? "/",
          authorization: req.headers["authorization"] as string | undefined,
          body,
        });
        const turn = this.script.shift() ?? this.fallback;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of renderTurn(turn, this.modelId)) res.write(chunk);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, host, () => {
        this.port = (this.server?.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }
}
