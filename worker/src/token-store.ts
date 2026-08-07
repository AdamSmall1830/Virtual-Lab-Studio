/**
 * Where the worker credential lives.
 *
 * Its own file, owner-readable only, and never the config file. Config files
 * get committed to dotfile repositories, pasted into forum posts and attached
 * to bug reports; a credential that lives in one will eventually be published.
 *
 * The token is also never logged, never passed as a command-line argument, and
 * never handed to the sandbox. The only place it appears is an Authorization
 * header on an outbound request to the studio.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "./logging.js";

export function readWorkerToken(path: string): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    // A world-readable credential is worth complaining about even though we
    // will still use it: the operator may have copied it with a permissive
    // umask and would otherwise never find out.
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      log.warn("The worker token file is readable by other users on this machine", { path });
    }
    const token = readFileSync(path, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

export function writeWorkerToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement POSIX modes; NTFS inheritance applies instead.
  }
}

export function clearWorkerToken(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to do: the caller is already tearing down.
  }
}
