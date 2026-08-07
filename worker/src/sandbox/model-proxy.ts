/**
 * The narrow model proxy, and the worker's meter.
 *
 * The sandbox has no route to anything except this process, and this process
 * forwards only what a chat completion needs. That buys four things worth the
 * moving part:
 *
 * *The provider credential never enters the sandbox.* The operator's key is
 * held here, on the host, and attached as the request leaves. Model-generated
 * Python cannot read an environment variable that was never set for it. The
 * sandbox instead gets a random per-job bearer token which is worthless
 * anywhere else and dies with the job.
 *
 * *Egress is an allow-list, not a firewall rule.* Method and path are matched
 * against a closed set before anything is forwarded, so a compromised runner
 * cannot use the one hole it has as a general-purpose HTTP client -- no
 * arbitrary host, no arbitrary path on the model server, no upload channel
 * beyond a bounded JSON body.
 *
 * *Consumption is measured, not reported.* Every model call in a job passes
 * through here, which makes this the only place in the system that can say what
 * a turn actually cost without taking the sandbox's word for it. A runner that
 * under-reports its usage -- because it is buggy, or because someone modified
 * it -- would otherwise slip past the meeting's token and cost limits, since
 * both the worker and the studio would be validating a number the sandbox
 * supplied. So the proxy reads ``usage`` off the responses it forwards and the
 * host treats that as the floor.
 *
 * *The budget is enforced where the spending happens.* When measured usage
 * passes the meeting's ceiling, further calls are refused here. Stopping at the
 * chokepoint is the difference between a limit and a preference.
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

import { log } from "../logging.js";
import { safeErrorMessage } from "../redact.js";

/** The only endpoints an OpenAI-compatible coordinator needs. */
const ALLOWED_PATHS = new Set([
  "/chat/completions",
  "/completions",
  "/models",
  "/embeddings",
]);

/** Endpoints whose responses carry usage and therefore count against a budget. */
const METERED_PATHS = new Set(["/chat/completions", "/completions", "/embeddings"]);

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;
/**
 * How much of the tail of a response to keep while looking for usage. In a JSON
 * body usage sits at the end; in an SSE stream it arrives in the final data
 * frame. Keeping a bounded tail measures both without ever buffering a whole
 * response.
 */
const USAGE_SCAN_BYTES = 64 * 1024;

export interface ProxyTarget {
  /** Upstream base, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Resolved at construction and never logged. */
  apiKey: string | null;
}

/**
 * What the meeting allows, translated into things this proxy can count.
 *
 * ``maxCalls`` is a runaway backstop rather than a turn limit: one agent turn
 * legitimately makes several model calls as it works through its tools. It
 * exists because a call whose response carried no usage cannot be charged
 * against ``maxTokens``, and an unmeasured loop would otherwise be unbounded.
 */
export interface ProxyBudget {
  maxTokens: number;
  maxCalls: number;
  /**
   * The most a single response may generate, which is the model's own per-call
   * ceiling. Used to clamp a request that declares no limit of its own, and to
   * keep one call from reserving the whole budget while it runs.
   */
  maxOutputPerCall?: number;
  /**
   * How many metered calls may be in flight at once.
   *
   * Legitimate parallelism has a known ceiling -- one call per live agent -- so
   * anything past it is a runner opening sockets, and a thousand simultaneous
   * requests is a denial of service against the operator's own model server
   * whether or not it stays inside the token budget.
   */
  maxConcurrent?: number;
}

export interface MeasuredUsage {
  /** Model calls the proxy actually forwarded. */
  model_call_count: number;
  input_tokens: number;
  output_tokens: number;
  /** Calls whose response declared no usage, so the totals above understate. */
  unmeasured_calls: number;
}

export interface ModelProxyOptions {
  target: ProxyTarget;
  /** The sandbox must present this exact bearer token. */
  jobToken: string;
  /** Bind address. Container mode binds to all interfaces on a private net. */
  host: string;
  port?: number;
  /** When present, calls stop once the job has spent its allowance. */
  budget?: ProxyBudget;
  /** Called once, the first time the budget is exceeded. */
  onBudgetExceeded?: (reason: "tokens" | "calls") => void;
}

export interface ModelProxyHandle {
  readonly port: number;
  readonly calls: () => number;
  /** What this job actually consumed, as observed on the wire. */
  readonly usage: () => MeasuredUsage;
  readonly budgetExceeded: () => "tokens" | "calls" | null;
  close(): Promise<void>;
}

function forwardTo(target: URL) {
  return target.protocol === "https:" ? httpsRequest : httpRequest;
}

/**
 * Pull the last usage object out of a response tail.
 *
 * Deliberately a scan rather than a parse: the tail may be a fragment of JSON
 * or a run of server-sent events, and the only thing needed from it is the
 * final token count. Both OpenAI's spelling and the ``input``/``output``
 * variant some servers use are accepted; a response that declares neither is
 * reported as unmeasured rather than assumed to be free.
 */
export function extractUsage(tail: string): { input: number; output: number } | null {
  const read = (names: string[]): number | null => {
    let found: number | null = null;
    for (const name of names) {
      const pattern = new RegExp(`"${name}"\\s*:\\s*(\\d{1,12})`, "g");
      for (const match of tail.matchAll(pattern)) {
        const value = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(value)) found = value;
      }
    }
    return found;
  };
  const input = read(["prompt_tokens", "input_tokens"]);
  const output = read(["completion_tokens", "output_tokens"]);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0 || body.length > 4 * 1024 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Ask a streaming request to report its usage.
 *
 * OpenAI-compatible servers omit usage from a stream unless the caller opts in,
 * which would leave every real job unmeasured -- the agent SDK streams. The
 * opt-in is therefore *overridden*, not merely defaulted: a caller that sends
 * ``stream_options: {include_usage: false}``, or an empty object, has asked not
 * to be counted, and honouring that would hand the sandbox a switch for turning
 * off the meter that constrains it. A server too old to know the option is
 * handled by the retry below rather than by giving up on measuring.
 */
function withUsageOptions(
  body: Buffer,
  parsed: Record<string, unknown> | null,
): { body: Buffer; injected: boolean } {
  if (!parsed || parsed["stream"] !== true) return { body, injected: false };
  const existing = parsed["stream_options"];
  const merged =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), include_usage: true }
      : { include_usage: true };
  return {
    body: Buffer.from(JSON.stringify({ ...parsed, stream_options: merged }), "utf8"),
    injected: true,
  };
}

/**
 * Fit a call inside what is left of the budget, before it is forwarded.
 *
 * Two problems are solved in one place. The first is the race: counting only on
 * the way back lets a runner open many calls at once, have every one of them
 * pass the same "not over yet" check, and spend the overage before the first
 * response lands -- so each call holds a reservation while it is in flight.
 *
 * The second is that a reservation alone does not make a ceiling enforceable. A
 * single request asking for a million output tokens against a hundred-token
 * budget would still be forwarded, and refusing the *next* call is no comfort
 * once that one has run. So the output ceiling is rewritten down to what the
 * budget can still afford. The generation limit is then enforced by the model
 * server, which is outside the sandbox and cannot be argued with, rather than
 * by hoping the caller declared something reasonable.
 *
 * The input side is estimated from the request's own bytes. That estimate can
 * be off by a modest factor either way -- a tokenizer is not a byte counter --
 * so the response settles it to the measured figure. The overshoot this permits
 * is a fraction of one prompt, not an unbounded spend, and a prompt large
 * enough to matter cannot fit the remaining budget in the first place.
 */
const BYTES_PER_TOKEN = 3;
/** Below this, there is not enough budget left for an answer worth having. */
const MIN_OUTPUT_ALLOWANCE = 64;
/** Stand-in for a model's per-response ceiling when the caller supplies none. */
const DEFAULT_OUTPUT_CEILING = 8_192;
/** Every field an OpenAI-compatible server may read an output ceiling from. */
const CEILING_FIELDS = ["max_tokens", "max_completion_tokens"] as const;
/** The most completions one call may ask for, however it asks. */
const MAX_COMPLETIONS = 128;

/** Read a completion-multiplying field, refusing anything it cannot verify. */
function countField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), MAX_COMPLETIONS);
}

export interface CallPlan {
  /** The body to forward, with its output ceiling clamped to the budget. */
  body: Buffer;
  parsed: Record<string, unknown>;
  /** Held against the budget until the response settles it. */
  reserve: number;
}

export function planCall(args: {
  body: Buffer;
  parsed: Record<string, unknown>;
  /** False for embeddings, which generate nothing. */
  generates: boolean;
  /** Tokens still available, or null when no budget applies. */
  remaining: number | null;
  /** The most one response can generate; the model's own per-call ceiling. */
  maxOutputPerCall: number;
}): CallPlan | { refused: "tokens" } {
  const input = Math.ceil(args.body.length / BYTES_PER_TOKEN);
  if (!args.generates) {
    if (args.remaining !== null && input > args.remaining) return { refused: "tokens" };
    return { body: args.body, parsed: args.parsed, reserve: input };
  }

  // Every field that could carry an output ceiling is rewritten, not just the
  // one this code would have read. Implementations differ over which of the two
  // they honour, so leaving either untouched hands the caller a choice of which
  // limit the server actually applies -- and it would pick the loose one.
  const present = CEILING_FIELDS.filter((name) => name in args.parsed);
  const declaredValues = present
    .map((name) => args.parsed[name])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => Math.floor(value))
    .filter((value) => value > 0);
  const declared = declaredValues.length > 0 ? Math.min(...declaredValues) : null;

  // ``n`` and ``best_of`` both multiply what the server generates, so the
  // per-completion ceiling is divided by them -- and the capped figures are
  // written back, so what is forwarded is exactly what was accounted for.
  const choices = countField(args.parsed["n"]);
  const candidates = countField(args.parsed["best_of"]);
  const multiplier = Math.max(choices, candidates);

  const withCounts = (body: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...body };
    if ("n" in args.parsed) out["n"] = choices;
    if ("best_of" in args.parsed) out["best_of"] = candidates;
    return out;
  };

  // With no budget there is nothing to clamp to, but the multipliers are still
  // pinned so the reservation cannot be outrun.
  if (args.remaining === null) {
    const assumed = Math.min(declared ?? args.maxOutputPerCall, args.maxOutputPerCall);
    const parsed = withCounts(args.parsed);
    return {
      body: Buffer.from(JSON.stringify(parsed), "utf8"),
      parsed,
      reserve: input + assumed * multiplier,
    };
  }

  const headroom = args.remaining - input;
  if (headroom < MIN_OUTPUT_ALLOWANCE) return { refused: "tokens" };
  // Never hand one call the entire remaining budget: it would be reserved in
  // full for the duration, and every concurrent sibling would be refused for a
  // shortage that only exists on paper.
  const affordable = Math.min(
    Math.max(1, Math.floor(headroom / multiplier)),
    args.maxOutputPerCall,
  );
  const perCompletion = declared === null ? affordable : Math.min(declared, affordable);

  const parsed = withCounts(args.parsed);
  for (const name of present.length > 0 ? present : ["max_tokens"]) {
    parsed[name] = perCompletion;
  }
  return {
    body: Buffer.from(JSON.stringify(parsed), "utf8"),
    parsed,
    reserve: input + perCompletion * multiplier,
  };
}

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxyHandle> {
  const base = new URL(options.target.baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const measured: MeasuredUsage = {
    model_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    unmeasured_calls: 0,
  };
  let exceeded: "tokens" | "calls" | null = null;
  /** Set if the upstream rejected the usage opt-in, so it is tried only once. */
  let usageOptionsRejected = false;
  /** Estimated spend of the calls currently in flight; see ``planCall``. */
  let reservedTokens = 0;
  let inFlight = 0;

  const noteExceeded = (reason: "tokens" | "calls"): void => {
    if (exceeded) return;
    exceeded = reason;
    options.onBudgetExceeded?.(reason);
  };

  /**
   * Decide whether one more call may be forwarded, counting what is already on
   * the wire. Both the call count and the reservation move before the request
   * leaves, so two simultaneous callers cannot both pass the same check.
   */
  const admit = (): "tokens" | "calls" | "concurrency" | null => {
    const budget = options.budget;
    if (!budget) return null;
    // ``model_call_count`` is incremented at dispatch, so it already includes
    // whatever is in flight. Adding ``inFlight`` here would charge those calls
    // twice.
    if (measured.model_call_count >= budget.maxCalls) return "calls";
    if (remainingTokens() <= 0) return "tokens";
    if (inFlight >= (budget.maxConcurrent ?? 8)) return "concurrency";
    return null;
  };

  /** What the budget can still afford, with in-flight reservations deducted. */
  const remainingTokens = (): number => {
    const budget = options.budget;
    if (!budget) return Number.MAX_SAFE_INTEGER;
    return budget.maxTokens - measured.input_tokens - measured.output_tokens - reservedTokens;
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const deny = (status: number, message: string): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "vls_proxy_denied" } }));
    };

    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${options.jobToken}`) {
      deny(401, "This proxy serves one job and requires that job's token.");
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST" && method !== "GET") {
      deny(405, "Only GET and POST are forwarded.");
      return;
    }
    // Match on the path alone; a query string is not forwarded because none of
    // the allowed endpoints needs one and it is a convenient exfiltration slot.
    const requestPath = (req.url ?? "/").split("?")[0] ?? "/";
    const suffix = requestPath.startsWith(basePath)
      ? requestPath.slice(basePath.length) || "/"
      : requestPath;
    if (!ALLOWED_PATHS.has(suffix)) {
      deny(403, "That endpoint is not part of this worker's model allow-list.");
      return;
    }
    const metered = METERED_PATHS.has(suffix);

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        aborted = true;
        deny(413, "The request body exceeded this worker's limit.");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const original = Buffer.concat(chunks);
      const upstream = new URL(`${basePath}${suffix === "/" ? "" : suffix}`, base);

      // The body to forward. For a metered call this is the caller's request
      // with its output ceiling clamped to what the budget can still afford.
      let forwardBody: Buffer = original;
      let forwardParsed: Record<string, unknown> | null = null;
      let reserved = 0;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        inFlight -= 1;
        reservedTokens -= reserved;
      };

      if (metered) {
        const parsed = parseJsonBody(original);
        if (!parsed) {
          // An unparseable body cannot be sized or clamped, and a request whose
          // shape is unknown is a request whose cost is unknown.
          deny(400, "A model call must be a JSON object this worker can account for.");
          return;
        }
        const breach = admit();
        if (breach === "concurrency") {
          deny(429, "Too many model calls are already in flight for this job.");
          return;
        }
        if (breach) {
          noteExceeded(breach);
          deny(429, "This job has spent the model allowance the meeting granted it.");
          return;
        }
        const plan = planCall({
          body: original,
          parsed,
          generates: suffix !== "/embeddings",
          remaining: options.budget ? remainingTokens() : null,
          maxOutputPerCall: options.budget?.maxOutputPerCall ?? DEFAULT_OUTPUT_CEILING,
        });
        if ("refused" in plan) {
          noteExceeded(plan.refused);
          deny(429, "This job has spent the model allowance the meeting granted it.");
          return;
        }
        forwardBody = plan.body;
        forwardParsed = plan.parsed;
        reserved = plan.reserve;
        reservedTokens += reserved;
        inFlight += 1;
        // Counted on the way out, not on the way back: a call that was
        // forwarded has already cost the operator's hardware whether or not a
        // response ever arrives.
        measured.model_call_count += 1;
      }

      /**
       * Close the books on this call: swap the reservation for what the
       * response actually declared, then re-check the budget. Idempotent,
       * because a stream can end, error and be closed by the client in any
       * order and the allowance must be returned exactly once. A null status
       * means the call was abandoned before anything came back.
       */
      let accounted = false;
      const settle = (status: number | null, tail: string): void => {
        if (!metered || accounted) return;
        accounted = true;
        release();
        const usage = status !== null && status < 400 ? extractUsage(tail) : null;
        if (usage) {
          measured.input_tokens += usage.input;
          measured.output_tokens += usage.output;
        } else if (status !== null && status < 400) {
          measured.unmeasured_calls += 1;
        }
        const breach = admit();
        if (breach === "tokens" || breach === "calls") noteExceeded(breach);
      };

      // Registered before anything is dispatched. A caller that hangs up during
      // connect or while waiting for the first byte must still take the model
      // request down with it; waiting for a response that will never be read
      // would hold a concurrency slot for the full upstream timeout.
      let liveRequest: ReturnType<typeof httpRequest> | null = null;
      let lastStatus: number | null = null;
      let tail = "";
      res.on("close", () => {
        if (res.writableFinished) return;
        liveRequest?.destroy();
        settle(lastStatus, tail);
      });

      /** One attempt at the upstream. Retried once without the usage opt-in. */
      const attempt = (body: Buffer, injected: boolean): void => {
        const headers: Record<string, string> = {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(body.length),
        };
        if (options.target.apiKey) headers["authorization"] = `Bearer ${options.target.apiKey}`;

        const proxied = forwardTo(upstream)(
          {
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
            path: upstream.pathname,
            method,
            headers,
            timeout: UPSTREAM_TIMEOUT_MS,
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode ?? 502;
            // A server that does not understand the usage opt-in gets the
            // clamped request back rather than a failed job. Measuring is worth
            // a retry; it is not worth breaking someone's model server. The
            // budget clamp is *not* undone by the retry.
            if (injected && status >= 400 && status < 500) {
              usageOptionsRejected = true;
              upstreamRes.resume();
              log.debug("The model server rejected the usage option; retrying without it");
              attempt(forwardBody, false);
              return;
            }
            lastStatus = status;

            // The client may already have gone away while this was connecting.
            if (res.writableEnded || res.destroyed) {
              upstreamRes.destroy();
              proxied.destroy();
              settle(status, tail);
              return;
            }

            // Headers are rebuilt rather than forwarded: an upstream Set-Cookie
            // or Location has no business inside the sandbox.
            res.writeHead(status, {
              "content-type": upstreamRes.headers["content-type"] ?? "application/json",
            });

            upstreamRes.on("data", (chunk: Buffer) => {
              if (!res.write(chunk)) {
                upstreamRes.pause();
                res.once("drain", () => upstreamRes.resume());
              }
              if (!metered) return;
              tail += chunk.toString("utf8");
              if (tail.length > USAGE_SCAN_BYTES) tail = tail.slice(-USAGE_SCAN_BYTES);
            });
            upstreamRes.on("end", () => {
              res.end();
              settle(status, tail);
            });
            upstreamRes.on("error", () => {
              res.end();
              settle(status, tail);
            });
          },
        );
        liveRequest = proxied;
        proxied.on("timeout", () => proxied.destroy(new Error("Model server timed out.")));
        proxied.on("error", (error) => {
          log.warn("Model proxy upstream error", { reason: safeErrorMessage(error) });
          if (!res.headersSent && !res.destroyed) {
            deny(502, "The local model server could not be reached.");
          } else if (!res.writableEnded) {
            res.end();
          }
          settle(502, "");
        });
        proxied.end(body);
      };

      if (metered && !usageOptionsRejected) {
        const prepared = withUsageOptions(forwardBody, forwardParsed);
        attempt(prepared.body, prepared.injected);
      } else {
        attempt(forwardBody, false);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    calls: () => measured.model_call_count,
    usage: () => ({ ...measured }),
    budgetExceeded: () => exceeded,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
