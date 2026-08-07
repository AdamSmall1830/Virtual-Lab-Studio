/**
 * Reading the job bundle.
 *
 * The archive comes from this product's own server, but it is unpacked onto
 * the operator's filesystem, so it is treated as hostile input anyway. A ZIP
 * is the classic vehicle for path traversal: entry names carrying ``..``,
 * absolute paths, Windows drive letters, backslashes, NUL bytes, or a
 * declared size that does not match what decompresses.
 *
 * Rather than depend on an extraction library and configure it carefully, this
 * module reads the central directory itself and matches every entry name
 * against a closed pattern. The bundle format is fixed and small -- three
 * metadata files plus one text file per evidence source -- so an entry that
 * does not match that pattern is not an edge case to sanitise, it is a bundle
 * this worker refuses.
 *
 * Nothing is ever written to a path derived from an archive entry. Names are
 * matched, then the *matched* name is used, which makes traversal structurally
 * impossible rather than filtered out.
 */
import { inflateRawSync } from "node:zlib";

import type { EvidenceManifest, EvidenceManifestEntry } from "./protocol.js";

/** The only entry names a bundle may contain. */
const ENTRY_PATTERN = /^(?:request\.json|task\.md|evidence-manifest\.json|evidence\/[A-Za-z0-9_-]{1,60}\.txt)$/;

const MAX_ENTRIES = 256;
const MAX_TOTAL_UNCOMPRESSED = 16 * 1024 * 1024;

const SIG_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const SIG_CENTRAL_FILE_HEADER = 0x02014b50;
const SIG_LOCAL_FILE_HEADER = 0x04034b50;

export class BundleError extends Error {}

export interface JobBundle {
  /** The immutable request contract, verbatim. */
  request: Record<string, unknown>;
  /** The rendered participant brief. */
  taskMarkdown: string;
  manifest: EvidenceManifest;
  /** Evidence text keyed by the manifest's ``file`` entry name. */
  evidence: Map<string, string>;
}

interface RawEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(data: Buffer): RawEntry[] {
  // The end-of-central-directory record is at the tail, after a comment of up
  // to 64 KiB. Scan backwards for its signature.
  const searchFrom = Math.max(0, data.length - (0xffff + 22));
  let eocd = -1;
  for (let i = data.length - 22; i >= searchFrom; i -= 1) {
    if (data.readUInt32LE(i) === SIG_END_OF_CENTRAL_DIRECTORY) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BundleError("The job bundle is not a readable archive.");

  const entryCount = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ENTRIES) {
    throw new BundleError("The job bundle declares more entries than expected.");
  }
  if (directoryOffset + directorySize > data.length) {
    throw new BundleError("The job bundle's directory is truncated.");
  }

  const entries: RawEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== SIG_CENTRAL_FILE_HEADER) {
      throw new BundleError("The job bundle's directory is malformed.");
    }
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localHeaderOffset = data.readUInt32LE(cursor + 42);
    // Decoded as latin1 on purpose: this is a byte-exact read used only for
    // pattern matching. UTF-8 decoding could fold distinct byte sequences onto
    // the same string and let a crafted name slip past the pattern.
    const name = data.toString("latin1", cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(data: Buffer, entry: RawEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > data.length || data.readUInt32LE(offset) !== SIG_LOCAL_FILE_HEADER) {
    throw new BundleError(`The job bundle entry ${entry.name} is malformed.`);
  }
  const nameLength = data.readUInt16LE(offset + 26);
  const extraLength = data.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > data.length) {
    throw new BundleError(`The job bundle entry ${entry.name} is truncated.`);
  }
  const raw = data.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) {
    throw new BundleError(`The job bundle uses an unsupported compression method.`);
  }
  // maxOutputLength turns a zip bomb into an error rather than an allocation.
  const inflated = inflateRawSync(raw, { maxOutputLength: MAX_TOTAL_UNCOMPRESSED });
  if (inflated.length !== entry.uncompressedSize) {
    throw new BundleError(`The job bundle entry ${entry.name} did not match its declared size.`);
  }
  return inflated;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new BundleError(`The evidence manifest is missing ${key}.`);
  }
  return value;
}

function parseManifest(text: string): EvidenceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BundleError("The evidence manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BundleError("The evidence manifest is not an object.");
  }
  const source = parsed as Record<string, unknown>;
  const evidenceRaw = source["evidence"];
  if (!Array.isArray(evidenceRaw)) {
    throw new BundleError("The evidence manifest has no evidence list.");
  }
  const evidence: EvidenceManifestEntry[] = evidenceRaw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BundleError(`Evidence manifest entry ${index} is not an object.`);
    }
    const record = item as Record<string, unknown>;
    const file = requireString(record, "file");
    if (!ENTRY_PATTERN.test(file) || !file.startsWith("evidence/")) {
      throw new BundleError(`Evidence manifest entry ${index} names an unexpected file.`);
    }
    return {
      evidence_key: requireString(record, "evidence_key"),
      file,
      title: typeof record["title"] === "string" ? record["title"] : null,
      citation: typeof record["citation"] === "string" ? record["citation"] : null,
      content_sha256:
        typeof record["content_sha256"] === "string" ? record["content_sha256"] : null,
      chunk_count: typeof record["chunk_count"] === "number" ? record["chunk_count"] : 0,
      truncated: record["truncated"] === true,
      trust: typeof record["trust"] === "string" ? record["trust"] : "untrusted_data",
    };
  });
  return {
    schema_version: requireString(source, "schema_version"),
    job_id: requireString(source, "job_id"),
    request_sha256: requireString(source, "request_sha256"),
    meeting_definition_sha256:
      typeof source["meeting_definition_sha256"] === "string"
        ? source["meeting_definition_sha256"]
        : "",
    evidence,
  };
}

/**
 * Parse a bundle into memory.
 *
 * Nothing is written to disk here. The caller decides what to materialise into
 * the disposable job workspace, which keeps the traversal-sensitive step --
 * choosing a filename -- in one place under this worker's control.
 */
export function readBundle(bytes: Uint8Array, expectedJobId: string, expectedRequestSha: string): JobBundle {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(data);

  const files = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    if (!ENTRY_PATTERN.test(entry.name)) {
      throw new BundleError(
        "The job bundle contains an entry name this worker does not accept; refusing it.",
      );
    }
    if (files.has(entry.name)) {
      throw new BundleError("The job bundle contains a duplicate entry name.");
    }
    total += entry.uncompressedSize;
    if (total > MAX_TOTAL_UNCOMPRESSED) {
      throw new BundleError("The job bundle expands to more data than expected.");
    }
    files.set(entry.name, readEntryData(data, entry).toString("utf8"));
  }

  const requestText = files.get("request.json");
  const manifestText = files.get("evidence-manifest.json");
  const taskMarkdown = files.get("task.md");
  if (!requestText || !manifestText || taskMarkdown === undefined) {
    throw new BundleError("The job bundle is missing a required file.");
  }

  let request: unknown;
  try {
    request = JSON.parse(requestText);
  } catch {
    throw new BundleError("The job request contract is not valid JSON.");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new BundleError("The job request contract is not an object.");
  }

  const manifest = parseManifest(manifestText);
  // The lease and the bundle are two separate requests. Binding them means a
  // bundle cached from an earlier attempt, or handed over by a confused
  // server, cannot be executed against this lease.
  if (manifest.job_id !== expectedJobId) {
    throw new BundleError("The job bundle belongs to a different job.");
  }
  if (manifest.request_sha256 !== expectedRequestSha) {
    throw new BundleError("The job bundle does not match the leased request hash.");
  }

  const evidence = new Map<string, string>();
  for (const item of manifest.evidence) {
    const text = files.get(item.file);
    if (text === undefined) {
      throw new BundleError(`The evidence manifest references a file the bundle does not contain.`);
    }
    evidence.set(item.file, text);
  }

  return { request: request as Record<string, unknown>, taskMarkdown, manifest, evidence };
}
