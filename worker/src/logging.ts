/**
 * The operator's console.
 *
 * A bridge worker is unusual in that its logs are read by the person who owns
 * both machines, so they may be far more detailed than anything sent upstream.
 * The scrub still applies to interpolated values: these logs get pasted into
 * bug reports, and "it only went to my terminal" is how credentials leak.
 */
import { redact, safeErrorMessage } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const time = new Date().toISOString();
  const parts = [`${time} ${level.toUpperCase().padEnd(5)} ${message}`];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${format(value)}`);
    }
  }
  const line = parts.join(" ");
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function format(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(safeErrorMessage(value));
  if (typeof value === "string") return JSON.stringify(redact(value));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(redact(JSON.stringify(value)));
  } catch {
    return '"[unserializable]"';
  }
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
