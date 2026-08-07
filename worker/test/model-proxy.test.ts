/**
 * Tests for the model proxy, written from the attacker's side.
 *
 * The proxy is the only component that sees every model call a job makes, so
 * it is where a bound can actually be enforced. These tests therefore do not
 * ask "does a well-behaved runner get its answer" -- they ask what happens when
 * the code inside the sandbox is not the code that was shipped: an unknown
 * endpoint, a missing token, a stream that never declares its usage, a loop
 * that keeps calling after the meeting's tokens are gone.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { extractUsage, startModelProxy } from "../src/sandbox/model-proxy.js";
import type { ModelProxyHandle } from "../src/sandbox/model-proxy.js";

interface UpstreamCall {
  path: string;
  method: string;
  body: string;
  authorization: string | undefined;
}

interface UpstreamReply {
  status?: number;
  contentType?: string;
  body: string;
}

/** A stand-in for the operator's local model server. */
class FakeModelServer {
  readonly calls: UpstreamCall[] = [];
  private server: Server | null = null;
  private reply: (call: UpstreamCall) => UpstreamReply | Promise<UpstreamReply> = () => ({
    body: "{}",
  });
  /** Takes over the response entirely, for streams that hang or never end. */
  raw: ((res: ServerResponse) => void) | null = null;
  port = 0;

  respondWith(reply: (call: UpstreamCall) => UpstreamReply | Promise<UpstreamReply>): void {
    this.raw = null;
    this.reply = reply;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const call: UpstreamCall = {
          path: req.url ?? "/",
          method: req.method ?? "GET",
          body: Buffer.concat(chunks).toString("utf8"),
          authorization: req.headers["authorization"] as string | undefined,
        };
        this.calls.push(call);
        if (this.raw) {
          this.raw(res);
          return;
        }
        void Promise.resolve(this.reply(call)).then((out) => {
          res.writeHead(out.status ?? 200, {
            "content-type": out.contentType ?? "application/json",
          });
          res.end(out.body);
        });
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.server?.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function sse(frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join("") + "data: [DONE]\n\n";
}

const TOKEN = "job-token-abc";

let upstream: FakeModelServer;

async function withProxy(
  options: Partial<Parameters<typeof startModelProxy>[0]>,
  body: (proxy: ModelProxyHandle, call: (path: string, payload?: unknown, token?: string) => Promise<{ status: number; text: string }>) => Promise<void>,
): Promise<void> {
  const proxy = await startModelProxy({
    target: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "sk-operator-secret" },
    jobToken: TOKEN,
    host: "127.0.0.1",
    ...options,
  });
  const call = async (
    path: string,
    payload?: unknown,
    token: string = TOKEN,
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, text: await response.text() };
  };
  try {
    await body(proxy, call);
  } finally {
    await proxy.close();
  }
}

describe("the model proxy", () => {
  before(async () => {
    upstream = new FakeModelServer();
    await upstream.start();
  });

  after(async () => {
    await upstream.stop();
  });

  it("refuses a caller without the job token", async () => {
    await withProxy({}, async (_proxy, call) => {
      const denied = await call("/v1/chat/completions", { model: "m" }, "not-the-token");
      assert.equal(denied.status, 401);
    });
  });

  it("refuses an endpoint outside the allow-list", async () => {
    upstream.respondWith(() => ({ body: "{}" }));
    const before = upstream.calls.length;
    await withProxy({}, async (_proxy, call) => {
      const denied = await call("/v1/internal/admin", { model: "m" });
      assert.equal(denied.status, 403);
    });
    assert.equal(upstream.calls.length, before, "nothing should reach the model server");
  });

  it("never lets the operator's key into the response path", async () => {
    upstream.respondWith(() => ({
      body: JSON.stringify({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }));
    await withProxy({}, async (_proxy, call) => {
      const reply = await call("/v1/chat/completions", { model: "m" });
      assert.equal(reply.status, 200);
      assert.ok(!reply.text.includes("sk-operator-secret"));
      const forwarded = upstream.calls.at(-1);
      assert.equal(forwarded?.authorization, "Bearer sk-operator-secret");
    });
  });

  it("counts what the model actually reported, not what the caller claims", async () => {
    upstream.respondWith(() => ({
      body: JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 1_200, completion_tokens: 300 },
      }),
    }));
    await withProxy({}, async (proxy, call) => {
      await call("/v1/chat/completions", { model: "m" });
      const usage = proxy.usage();
      assert.equal(usage.model_call_count, 1);
      assert.equal(usage.input_tokens, 1_200);
      assert.equal(usage.output_tokens, 300);
      assert.equal(usage.unmeasured_calls, 0);
    });
  });

  it("asks a stream to report its usage, and reads it out of the stream", async () => {
    upstream.respondWith(() => ({
      contentType: "text/event-stream",
      body: sse([
        JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
        JSON.stringify({ usage: { prompt_tokens: 900, completion_tokens: 100 } }),
      ]),
    }));
    await withProxy({}, async (proxy, call) => {
      const reply = await call("/v1/chat/completions", { model: "m", stream: true });
      assert.equal(reply.status, 200);
      assert.ok(reply.text.includes("[DONE]"), "the stream must still reach the caller intact");
      const forwarded = JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
      assert.deepEqual(forwarded["stream_options"], { include_usage: true });
      assert.equal(proxy.usage().input_tokens, 900);
      assert.equal(proxy.usage().output_tokens, 100);
    });
  });

  it("keeps working, and admits it is blind, when the server rejects the usage option", async () => {
    let seen = 0;
    upstream.respondWith((upstreamCall) => {
      seen += 1;
      if (upstreamCall.body.includes("include_usage")) {
        return { status: 400, body: JSON.stringify({ error: "unknown field stream_options" }) };
      }
      return {
        contentType: "text/event-stream",
        body: sse([JSON.stringify({ choices: [{ delta: { content: "hi" } }] })]),
      };
    });
    await withProxy({}, async (proxy, call) => {
      const first = await call("/v1/chat/completions", { model: "m", stream: true });
      assert.equal(first.status, 200, "the caller must not see the retry");
      assert.equal(seen, 2, "one rejected attempt, one retry");

      // The rejection is remembered, so the second call goes straight through.
      const second = await call("/v1/chat/completions", { model: "m", stream: true });
      assert.equal(second.status, 200);
      assert.equal(seen, 3);
      assert.ok(!(upstream.calls.at(-1)?.body ?? "").includes("include_usage"));

      const usage = proxy.usage();
      assert.equal(usage.model_call_count, 2);
      assert.equal(usage.unmeasured_calls, 2, "unmeasured is not the same as free");
      assert.equal(usage.input_tokens, 0);
    });
  });

  it("stops the job's model calls once it has spent the meeting's tokens", async () => {
    upstream.respondWith(() => ({
      body: JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 60 } }),
    }));
    const exceeded: string[] = [];
    await withProxy(
      {
        budget: { maxTokens: 150, maxCalls: 100 },
        onBudgetExceeded: (reason) => exceeded.push(reason),
      },
      async (proxy, call) => {
        const first = await call("/v1/chat/completions", { model: "m" });
        assert.equal(first.status, 200);
        const second = await call("/v1/chat/completions", { model: "m" });
        assert.equal(second.status, 429, "the second call is over budget and must be refused");
        assert.deepEqual(exceeded, ["tokens"]);
        assert.equal(proxy.budgetExceeded(), "tokens");
        assert.equal(proxy.usage().model_call_count, 1, "a refused call never reaches the model");
      },
    );
  });

  it("bounds a runaway loop even when nothing reports usage", async () => {
    upstream.respondWith(() => ({ body: JSON.stringify({ choices: [] }) }));
    const exceeded: string[] = [];
    await withProxy(
      {
        budget: { maxTokens: 1_000_000, maxCalls: 3 },
        onBudgetExceeded: (reason) => exceeded.push(reason),
      },
      async (proxy, call) => {
        for (let i = 0; i < 3; i += 1) {
          const reply = await call("/v1/chat/completions", { model: "m" });
          assert.equal(reply.status, 200);
        }
        const refused = await call("/v1/chat/completions", { model: "m" });
        assert.equal(refused.status, 429);
        assert.deepEqual(exceeded, ["calls"]);
        assert.equal(proxy.usage().unmeasured_calls, 3);
      },
    );
  });

  it("cannot be outrun by opening several calls at once", async () => {
    // Every request is held open until the test lets go, so all of them are in
    // flight while the proxy decides. Counting only on the way back would let
    // all five through on the strength of the same "not over yet" reading.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    upstream.respondWith(async () => {
      await gate;
      return { body: JSON.stringify({ usage: { prompt_tokens: 80, completion_tokens: 20 } }) };
    });

    await withProxy({ budget: { maxTokens: 100, maxCalls: 100 } }, async (proxy, call) => {
      const flight = Array.from({ length: 5 }, () =>
        call("/v1/chat/completions", { model: "m", max_tokens: 200 }),
      );
      await sleep(100);
      open();
      const replies = await Promise.all(flight);
      const admitted = replies.filter((reply) => reply.status === 200);
      const refused = replies.filter((reply) => reply.status === 429);
      // The first call holds its declared 200-token ceiling against a 100-token
      // budget, so the other four are refused while it is still on the wire.
      // Counting only on the way back would have let all five through.
      assert.equal(admitted.length, 1);
      assert.equal(refused.length, 4);
      assert.equal(proxy.usage().model_call_count, 1);
      assert.equal(proxy.budgetExceeded(), "tokens");
    });
  });

  it("clamps a call's output ceiling to what the budget can still afford", async () => {
    upstream.respondWith(() => ({
      body: JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    }));
    await withProxy({ budget: { maxTokens: 1_000, maxCalls: 10 } }, async (_proxy, call) => {
      const reply = await call("/v1/chat/completions", { model: "m", max_tokens: 1_000_000 });
      assert.equal(reply.status, 200);
      const forwarded = JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, number>;
      // A budget that can be knowingly exceeded by a single call is not a
      // budget. The ceiling is rewritten before the request is forwarded, so
      // the model server enforces it from outside the sandbox.
      assert.ok(
        forwarded["max_tokens"] !== undefined && forwarded["max_tokens"] < 1_000,
        `expected a clamped ceiling, got ${String(forwarded["max_tokens"])}`,
      );
    });
  });

  it("keeps the ceiling field the caller used, and divides it across n", async () => {
    upstream.respondWith(() => ({ body: "{}" }));
    await withProxy({ budget: { maxTokens: 100_000, maxCalls: 10 } }, async (_proxy, call) => {
      await call("/v1/chat/completions", { model: "m", max_completion_tokens: 999_999 });
      const first = JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
      assert.equal(first["max_tokens"], undefined, "must not add a field the server may reject");
      assert.equal(first["max_completion_tokens"], 8_192);

      await call("/v1/chat/completions", { model: "m", max_tokens: 500 });
      assert.equal(
        (JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>)["max_tokens"],
        500,
        "a modest ceiling of the caller's own is left alone",
      );
    });

    await withProxy({ budget: { maxTokens: 1_200, maxCalls: 10 } }, async (_proxy, call) => {
      await call("/v1/chat/completions", { model: "m", n: 4, max_tokens: 500 });
      const asked = JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
      // Four completions of 500 would cost 2,000 against a 1,200 budget, so the
      // per-completion ceiling has to come down for the total to fit.
      assert.equal(asked["n"], 4);
      assert.ok(
        typeof asked["max_tokens"] === "number" && asked["max_tokens"] * 4 <= 1_200,
        `expected the ceiling divided across n, got ${String(asked["max_tokens"])}`,
      );
    });
  });

  it("forwards the same limits it charged for", async () => {
    upstream.respondWith(() => ({ body: "{}" }));
    await withProxy({ budget: { maxTokens: 100_000, maxCalls: 10 } }, async (_proxy, call) => {
      // Both ceilings, one of them enormous: servers differ over which they
      // honour, so a request that leaves either loose has chosen its own limit.
      await call("/v1/chat/completions", {
        model: "m",
        max_completion_tokens: 1,
        max_tokens: 1_000_000,
      });
      const both = JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
      assert.equal(both["max_tokens"], 1);
      assert.equal(both["max_completion_tokens"], 1);

      // Reserving for 128 completions while the server generates 1,000 is the
      // same bypass wearing a different field.
      await call("/v1/chat/completions", { model: "m", n: 1_000, max_tokens: 100 });
      const many = JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
      assert.equal(many["n"], 128);

      // ``best_of`` generates candidates the caller never sees but still pays
      // for, and a string is not a number the proxy can verify.
      await call("/v1/chat/completions", { model: "m", best_of: 64, n: "8", max_tokens: 100 });
      const candidates = JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<
        string,
        unknown
      >;
      assert.equal(candidates["best_of"], 64);
      assert.equal(candidates["n"], 1);
    });
  });

  it("refuses a call the remaining budget cannot fund at all", async () => {
    upstream.respondWith(() => ({ body: "{}" }));
    await withProxy({ budget: { maxTokens: 100, maxCalls: 10 } }, async (proxy, call) => {
      const before = upstream.calls.length;
      const reply = await call("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "x".repeat(2_000) }],
      });
      assert.equal(reply.status, 429);
      assert.equal(
        upstream.calls.length,
        before,
        "a call that cannot fit must not be forwarded at all",
      );
      assert.equal(proxy.budgetExceeded(), "tokens");
    });
  });

  it("charges each call once against the call ceiling", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    upstream.respondWith(async () => {
      await gate;
      return { body: "{}" };
    });
    await withProxy(
      { budget: { maxTokens: 100_000, maxCalls: 3, maxConcurrent: 4 } },
      async (proxy, call) => {
        const flight = Array.from({ length: 3 }, () =>
          call("/v1/chat/completions", { model: "m" }),
        );
        await sleep(100);
        open();
        const replies = await Promise.all(flight);
        // Counting a call both as dispatched and as in flight would refuse the
        // third of three under a ceiling of three.
        assert.deepEqual(
          replies.map((reply) => reply.status),
          [200, 200, 200],
        );
        assert.equal(proxy.usage().model_call_count, 3);
      },
    );
  });

  it("cannot switch the meter off by sending its own stream options", async () => {
    upstream.respondWith(() => ({
      contentType: "text/event-stream",
      body: sse([JSON.stringify({ usage: { prompt_tokens: 900, completion_tokens: 100 } })]),
    }));
    await withProxy({}, async (proxy, call) => {
      await call("/v1/chat/completions", {
        model: "m",
        stream: true,
        stream_options: { include_usage: false },
      });
      assert.deepEqual(
        (JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>)[
          "stream_options"
        ],
        { include_usage: true },
        "an opt-out must be overridden, not honoured",
      );

      await call("/v1/chat/completions", { model: "m", stream: true, stream_options: {} });
      assert.deepEqual(
        (JSON.parse(upstream.calls.at(-1)?.body ?? "{}") as Record<string, unknown>)[
          "stream_options"
        ],
        { include_usage: true },
      );

      assert.equal(proxy.usage().input_tokens, 1_800);
      assert.equal(proxy.usage().unmeasured_calls, 0);
    });
  });

  it("stops the model and gives the allowance back when the caller hangs up", async () => {
    let upstreamClosed = false;
    upstream.raw = (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
      res.on("close", () => {
        upstreamClosed = true;
      });
      // Deliberately never ends: an abandoned generation that would keep the
      // operator's GPU busy if nobody tore it down.
    };

    await withProxy(
      { budget: { maxTokens: 100_000, maxCalls: 10, maxConcurrent: 1 } },
      async (proxy, call) => {
        const controller = new AbortController();
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "m", stream: true }),
          signal: controller.signal,
        });
        const reader = response.body?.getReader();
        await reader?.read();
        controller.abort();
        await sleep(200);

        assert.ok(upstreamClosed, "the model server must be told to stop generating");

        // With one slot, a leaked reservation would show up as a refusal here.
        upstream.respondWith(() => ({
          body: JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5 } }),
        }));
        const next = await call("/v1/chat/completions", { model: "m" });
        assert.equal(next.status, 200, "the abandoned call must have freed its slot");
        assert.equal(proxy.usage().model_call_count, 2);
      },
    );
  });

  it("gives the allowance back when the caller hangs up before the first byte", async () => {
    let upstreamClosed = false;
    upstream.raw = (res) => {
      // Headers are never written: the model is still thinking when the caller
      // walks away, which is the window a response-scoped handler would miss.
      res.on("close", () => {
        upstreamClosed = true;
      });
    };

    await withProxy(
      { budget: { maxTokens: 100_000, maxCalls: 10, maxConcurrent: 1 } },
      async (proxy, call) => {
        const controller = new AbortController();
        const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "m" }),
          signal: controller.signal,
        });
        await sleep(100);
        controller.abort();
        await pending.catch(() => undefined);
        await sleep(200);

        assert.ok(upstreamClosed, "the model server must be told to stop");
        upstream.respondWith(() => ({ body: "{}" }));
        const next = await call("/v1/chat/completions", { model: "m" });
        assert.equal(next.status, 200, "the abandoned call must have freed its slot");
      },
    );
  });

  it("leaves unmetered endpoints out of the budget", async () => {
    upstream.respondWith(() => ({ body: JSON.stringify({ data: [] }) }));
    await withProxy({ budget: { maxTokens: 10, maxCalls: 1 } }, async (proxy, call) => {
      await call("/v1/models");
      await call("/v1/models");
      assert.equal(proxy.usage().model_call_count, 0);
      assert.equal(proxy.budgetExceeded(), null);
    });
  });
});

describe("reading usage off a response", () => {
  it("takes the last usage block, which is the cumulative one in a stream", () => {
    const tail = sse([
      JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }),
      JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 40 } }),
    ]);
    assert.deepEqual(extractUsage(tail), { input: 10, output: 40 });
  });

  it("accepts the input/output spelling some servers use", () => {
    assert.deepEqual(
      extractUsage('{"usage":{"input_tokens":7,"output_tokens":9}}'),
      { input: 7, output: 9 },
    );
  });

  it("reports nothing rather than zero when a response declares no usage", () => {
    assert.equal(extractUsage('{"choices":[{"message":{"content":"hi"}}]}'), null);
  });
});
