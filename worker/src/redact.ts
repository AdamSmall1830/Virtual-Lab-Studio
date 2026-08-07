/**
 * Outbound scrubbing.
 *
 * Everything this worker sends upstream is short prose written by a language
 * model that has just been reading files, running Python and talking to a
 * model server. Summaries are therefore the most likely place for a home
 * directory, a bearer token or a local URL to escape, and the server cannot
 * catch that for us -- to the server a task summary is just a string under a
 * thousand characters.
 *
 * So the scrub happens here, at the last point where the operator's machine
 * still controls the bytes. It is deliberately blunt: a false positive costs a
 * researcher a slightly redacted sentence, a false negative puts someone's
 * filesystem layout into a permanent research record.
 */

const PLACEHOLDER = "[redacted]";

/**
 * Patterns are ordered most-specific first: a credential inside a URL should
 * be reported as a credential, not laundered into a bare host name.
 */
const PATTERNS: ReadonlyArray<RegExp> = [
  // Bearer tokens and this product's own credential prefixes.
  /\b(?:bearer|token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/gi,
  /\bvlsw_[A-Za-z0-9._-]+/g,
  /\bvlse_[A-Za-z0-9._-]+/g,
  // Common provider key shapes.
  /\bsk-[A-Za-z0-9._-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Any URL. A local model endpoint is as sensitive as a remote one: it
  // discloses the operator's network layout.
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  // Windows absolute paths, including UNC.
  /\\\\[^\s\\]+\\[^\s]*/g,
  /\b[A-Za-z]:[\\/][^\s"'<>|]*/g,
  // POSIX home and system paths. Bounded to real-looking segments so ordinary
  // prose containing a slash survives.
  /(?:~|\/(?:home|Users|root|job|tmp|var|etc|opt|usr|mnt|proc|srv))(?:\/[\w.@+-]+)*\/?/g,
  // Environment-variable references.
  /\$\{?[A-Z][A-Z0-9_]{2,}\}?/g,
  // Bare IPv4 with optional port.
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g,
];

/**
 * Replace anything that looks like a secret, a path, a URL or an address.
 *
 * Also collapses whitespace: a summary lifted out of terminal output arrives
 * full of newlines and box-drawing indentation that renders badly and pads the
 * length budget with nothing.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, PLACEHOLDER);
  }
  // Control characters would survive JSON encoding and reach a browser.
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Scrub, then clamp to the server's field bound.
 *
 * Truncation is marked rather than silent -- a summary that stops mid-sentence
 * with no explanation reads like the agent gave up.
 */
export function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = redact(value);
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

/**
 * Clamp without scrubbing.
 *
 * Used only for the participant's final response, which is the research output
 * itself. Redacting it would silently edit a scientific record; the pattern set
 * above cannot tell a genuine citation locator from a path. Prompt-level rules
 * and the researcher's own review govern that text instead.
 */
export function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

/**
 * Reduce an arbitrary thrown value to something safe to log or report.
 *
 * Stack traces are dropped entirely. They are the single richest source of
 * absolute paths in a Node process and they tell a researcher nothing.
 */
export function safeErrorMessage(error: unknown, maxLength = 300): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";
  return safeText(raw, maxLength) ?? "Unknown error";
}
