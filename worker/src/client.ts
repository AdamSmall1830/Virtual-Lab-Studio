/**
 * The typed client for Virtual Lab Studio's worker protocol.
 *
 * Every request is outbound HTTPS from the operator's machine. Nothing here
 * opens a port, and nothing here can be reached from the studio -- if the
 * researcher's browser could talk to this worker the whole isolation argument
 * would collapse.
 *
 * The retry policy is shaped by what actually goes wrong on a home connection:
 * the request lands, the reply is lost, the worker retries and the server sees
 * the same call twice. So retries are confined to the calls the server makes
 * idempotent (events dedupe on two keys; completion dedupes on the request
 * hash) plus plain reads. Leasing is never retried: a lost lease response
 * costs one job, whereas a retried lease could take a second job the worker
 * has no slot for.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { log } from "./logging.js";
import { safeErrorMessage } from "./redact.js";
import type {
  CompletionRequest,
  EnrollRequest,
  EnrolledResponse,
  EventBatch,
  EventBatchAck,
  FailRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  JobAck,
  JobControl,
  LeaseRequest,
  LeasedJob,
} from "./protocol.js";

/** How long any single HTTP call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The bundle is up to 8 MB over a home connection, so it gets its own budget. */
const BUNDLE_TIMEOUT_MS = 120_000;
/** Hard ceiling on a bundle download, mirroring the server's own cap. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 500, maxDelayMs: 15_000 };
const NO_RETRY: RetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

/**
 * An HTTP failure the caller may need to distinguish.
 *
 * ``code`` is the server's machine-readable ``detail.code`` where present.
 * The worker branches on a handful of these -- ``lease_lost``,
 * ``worker_disabled``, ``job_not_leased`` -- and treating them as opaque text
 * would mean parsing prose.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the credential itself is the problem, not this request. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isLeaseLost(): boolean {
    return (
      this.status === 409 ||
      this.code === "lease_lost" ||
      this.code === "job_not_leased" ||
      this.code === "lease_expired"
    );
  }
}

/** Raised when the transport failed; distinct from a server that answered. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function jitter(delayMs: number): number {
  // Full jitter. A fleet of workers that all lost the same server should not
  // come back in lockstep.
  return Math.round(Math.random() * delayMs);
}

export interface ClientOptions {
  baseUrl: string;
  /** The long-lived worker credential. Absent until enrollment completes. */
  token?: string | null;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

export class StudioClient {
  private token: string | null;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly doFetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token ?? null;
    this.userAgent = options.userAgent;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
      ...extra,
    };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    return headers;
  }

  /**
   * One request, with retries.
   *
   * Returns ``null`` for 204, which the lease endpoint uses to mean "nothing
   * for you" -- a common, unexceptional answer that should not allocate an
   * error or log a line.
   */
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    retry: RetryPolicy,
  ): Promise<T | null> {
    let lastError: Error = new TransportError("No attempt was made.");
    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(
            body === undefined ? undefined : { "content-type": "application/json" },
          ),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          // A redirect on an authenticated call would forward the credential to
          // wherever the response pointed.
          redirect: "error",
        });
        if (response.status === 204) return null;
        if (response.ok) {
          const text = await response.text();
          return text ? (JSON.parse(text) as T) : null;
        }
        const error = await this.toApiError(response);
        if (!isRetryableStatus(response.status) || attempt === retry.attempts) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof ApiError) {
          if (!isRetryableStatus(error.status) || attempt === retry.attempts) throw error;
          lastError = error;
        } else {
          const wrapped = new TransportError(safeErrorMessage(error));
          if (attempt === retry.attempts) throw wrapped;
          lastError = wrapped;
        }
      } finally {
        clearTimeout(timer);
      }
      const delay = jitter(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1)));
      log.debug("Retrying request", { method, path, attempt, delay, reason: lastError.message });
      await sleep(delay);
    }
    throw lastError;
  }

  private async toApiError(response: Response): Promise<ApiError> {
    let code = `http_${response.status}`;
    let message = `Request failed with status ${response.status}.`;
    try {
      const parsed = (await response.json()) as { detail?: unknown };
      const detail = parsed?.detail;
      if (detail && typeof detail === "object" && !Array.isArray(detail)) {
        const record = detail as Record<string, unknown>;
        if (typeof record["code"] === "string") code = record["code"];
        if (typeof record["message"] === "string") message = record["message"];
      } else if (typeof detail === "string") {
        message = detail;
      }
    } catch {
      // A non-JSON error body is usually a proxy page; the status is the signal.
    }
    return new ApiError(response.status, code, message);
  }

  // -- Enrollment ----------------------------------------------------------

  /** Exchange a one-time enrollment token for the long-lived credential. */
  async enroll(payload: EnrollRequest): Promise<EnrolledResponse> {
    const result = await this.request<EnrolledResponse>(
      "POST",
      "/api/v1/recursive-workers/enroll",
      payload,
      NO_RETRY,
    );
    if (!result) throw new TransportError("Enrollment returned an empty response.");
    return result;
  }

  // -- Liveness ------------------------------------------------------------

  async heartbeat(payload: HeartbeatRequest): Promise<HeartbeatResponse> {
    const result = await this.request<HeartbeatResponse>(
      "POST",
      "/api/v1/recursive-workers/heartbeat",
      payload,
      DEFAULT_RETRY,
    );
    if (!result) throw new TransportError("Heartbeat returned an empty response.");
    return result;
  }

  /**
   * Ask for work. ``null`` means the queue held nothing this worker can run.
   *
   * Never retried: see the note at the top of the file.
   */
  async leaseJob(payload: LeaseRequest): Promise<LeasedJob | null> {
    return this.request<LeasedJob>(
      "POST",
      "/api/v1/recursive-workers/jobs/lease",
      payload,
      NO_RETRY,
    );
  }

  async jobHeartbeat(jobId: string): Promise<JobControl> {
    const result = await this.request<JobControl>(
      "POST",
      `/api/v1/recursive-jobs/${encodeURIComponent(jobId)}/heartbeat`,
      {},
      NO_RETRY,
    );
    if (!result) throw new TransportError("Job heartbeat returned an empty response.");
    return result;
  }

  // -- Job payloads --------------------------------------------------------

  /**
   * Download the frozen evidence bundle.
   *
   * The lease hands back a ``bundle_url``. It is treated as untrusted: only
   * the path shape this worker expects is accepted, and it is always joined to
   * the configured server origin. A field that could redirect the download
   * elsewhere would turn a server compromise into evidence exfiltration to a
   * third party -- and into this worker sending its bearer token there.
   */
  async fetchBundle(jobId: string, bundleUrl: string): Promise<Uint8Array> {
    const expected = `/api/v1/recursive-jobs/${jobId}/bundle`;
    if (bundleUrl !== expected) {
      throw new TransportError(
        "The server returned an unexpected bundle location; refusing to download it.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BUNDLE_TIMEOUT_MS);
    try {
      const response = await this.doFetch(`${this.baseUrl}${expected}`, {
        method: "GET",
        headers: this.headers({ accept: "application/zip" }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw await this.toApiError(response);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > MAX_BUNDLE_BYTES) {
        throw new TransportError("The job bundle exceeded the expected maximum size.");
      }
      return buffer;
    } catch (error) {
      if (error instanceof ApiError || error instanceof TransportError) throw error;
      throw new TransportError(safeErrorMessage(error));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Post a batch of progress events. Safe to retry: the server dedupes. */
  async postEvents(jobId: string, batch: EventBatch): Promise<EventBatchAck> {
    const result = await this.request<EventBatchAck>(
      "POST",
      `/api/v1/recursive-jobs/${encodeURIComponent(jobId)}/events`,
      batch,
      DEFAULT_RETRY,
    );
    return result ?? { accepted: 0, duplicates: 0, rejected: 0 };
  }

  /**
   * Submit the finished result.
   *
   * Retried on transport failure because the alternative is worse: the work is
   * done, the tokens are spent, and a lost acknowledgement would throw all of
   * it away. The server keys deduplication on the request hash, so a second
   * delivery is recorded once.
   */
  async completeJob(jobId: string, payload: CompletionRequest): Promise<JobAck> {
    const result = await this.request<JobAck>(
      "POST",
      `/api/v1/recursive-jobs/${encodeURIComponent(jobId)}/complete`,
      payload,
      DEFAULT_RETRY,
    );
    if (!result) throw new TransportError("Completion returned an empty response.");
    return result;
  }

  async failJob(jobId: string, payload: FailRequest): Promise<JobAck> {
    const result = await this.request<JobAck>(
      "POST",
      `/api/v1/recursive-jobs/${encodeURIComponent(jobId)}/fail`,
      payload,
      DEFAULT_RETRY,
    );
    if (!result) throw new TransportError("Failure report returned an empty response.");
    return result;
  }

  /** Hand a job back unstarted so another worker, or a retry, can take it. */
  async releaseJob(jobId: string): Promise<JobAck> {
    const result = await this.request<JobAck>(
      "POST",
      `/api/v1/recursive-jobs/${encodeURIComponent(jobId)}/release`,
      {},
      DEFAULT_RETRY,
    );
    if (!result) throw new TransportError("Release returned an empty response.");
    return result;
  }
}
