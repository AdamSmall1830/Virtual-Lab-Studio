/**
 * Reading errors returned by the API.
 *
 * The generated client throws an `ApiError` whose parsed response body hangs off
 * `.data`. This backend reports failures as
 *
 *     { "detail": { "code": "spend_cap_exceeded", "message": "..." } }
 *
 * which matters for two reasons. First, `err.message` is NOT a substitute: the
 * client builds that string itself and only inlines `detail` when `detail` is a
 * plain string, so for this API it degrades to "HTTP 402 Payment Required" and
 * the operator-facing explanation is silently dropped. Second, several failures
 * are actionable — the caller wants to branch on `code` and offer a way forward
 * rather than print a sentence.
 *
 * FastAPI's own request validation uses the same key with a different shape
 * (a list of `{msg, loc}`), and some infrastructure errors return a bare string,
 * so both are handled here rather than at each call site.
 */

type ErrorBody = {
  detail?: unknown;
  message?: unknown;
  error?: unknown;
  title?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function body(err: unknown): ErrorBody | null {
  const e = asRecord(err);
  if (!e) return null;
  // ApiError.data holds the parsed body; a plain object body is also accepted so
  // callers can pass an already-unwrapped payload.
  const data = 'data' in e ? e.data : e;
  return asRecord(data) as ErrorBody | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The machine-readable failure code, when the API supplied one. Branch on this
 * to react to a specific, recoverable failure; never show it to the user.
 */
export function apiErrorCode(err: unknown): string | undefined {
  const detail = asRecord(body(err)?.detail);
  return str(detail?.code) ?? undefined;
}

/**
 * A human-readable explanation, preferring the server's own wording.
 *
 * `fallback` should describe the action that failed, because it is what the user
 * sees when the server offered no explanation.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const b = body(err);

  if (b) {
    const detail = b.detail;

    const asObject = asRecord(detail);
    if (asObject) {
      const message = str(asObject.message);
      if (message) return message;
    }

    const asString = str(detail);
    if (asString) return asString;

    // FastAPI request validation: [{ loc, msg, type }, ...]
    if (Array.isArray(detail)) {
      const first = asRecord(detail[0]);
      const msg = str(first?.msg);
      if (msg) return msg;
    }

    const top = str(b.message) ?? str(b.error) ?? str(b.title);
    if (top) return top;

    // A recognised error envelope with nothing readable in it: the caller's
    // description of the failed action beats a bare status line.
    return fallback;
  }

  // No response body at all — a network or client-side failure, where the
  // thrown message ("Failed to fetch") is the only real information available.
  if (err instanceof Error && err.message) return err.message;

  return fallback;
}
