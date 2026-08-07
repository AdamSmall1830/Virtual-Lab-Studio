/**
 * Reading structure out of the participant's final message.
 *
 * The model is asked for two trailing sections -- `## Citations` and
 * `## Limitations` -- in a fixed line format. Parsing prose is not something to
 * be smug about, but the alternative was worse: forcing the whole response
 * through a JSON tool call makes models write markedly worse prose, and the
 * prose is what the researcher reads.
 *
 * Two rules keep this honest.
 *
 * *The sections are removed from the response text.* What the researcher sees
 * is the participant's answer, not the machine-readable appendix, and leaving
 * both in would duplicate every claim.
 *
 * *A malformed line is dropped, not guessed at.* If a citation line cannot be
 * read, no citation is invented from it -- and because the validator rejects a
 * response whose citations do not resolve, a model that mangles the format
 * fails loudly instead of publishing unsourced claims.
 */
import type { SupportType } from "../protocol.js";

const SUPPORT_TYPES = new Set<SupportType>(["supports", "contradicts", "context", "uncertain"]);

export interface ParsedCitation {
  evidence_key: string;
  locator: string | null;
  claim: string;
  support_type: SupportType;
}

export interface ParsedResponse {
  finalText: string;
  citations: ParsedCitation[];
  limitations: string[];
}

/** Match a heading regardless of level or trailing punctuation. */
function headingIndex(lines: string[], name: string): number {
  const pattern = new RegExp(`^#{1,6}\\s*${name}\\s*:?\\s*$`, "i");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && pattern.test(line.trim())) return index;
  }
  return -1;
}

function collectBullets(lines: string[], start: number): { items: string[]; end: number } {
  const items: string[] = [];
  let index = start;
  while (index < lines.length) {
    const raw = lines[index];
    if (raw === undefined) break;
    const line = raw.trim();
    if (line === "") {
      index += 1;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    const bullet = line.replace(/^[-*+]\s+/, "");
    if (bullet === line && items.length > 0) break;
    items.push(bullet);
    index += 1;
  }
  return { items, end: index };
}

function parseCitationLine(line: string): ParsedCitation | null {
  const parts = line.split("|").map((part) => part.trim());
  const key = parts[0];
  if (!key) return null;
  // A key with spaces is almost always the model writing prose instead of the
  // requested format; accepting it would produce a citation that cannot resolve.
  if (/\s/.test(key) || key.length > 128) return null;
  const locatorRaw = parts[1] ?? "";
  const locator = locatorRaw && locatorRaw !== "-" ? locatorRaw : null;
  const claim = parts[2] ?? "";
  const supportRaw = (parts[3] ?? "").toLowerCase();
  const support: SupportType = SUPPORT_TYPES.has(supportRaw as SupportType)
    ? (supportRaw as SupportType)
    : "context";
  return { evidence_key: key, locator, claim, support_type: support };
}

export function parseResponse(text: string): ParsedResponse {
  const lines = text.split(/\r?\n/);
  let cutoff = lines.length;

  const citations: ParsedCitation[] = [];
  const citationsAt = headingIndex(lines, "Citations");
  if (citationsAt >= 0) {
    const { items } = collectBullets(lines, citationsAt + 1);
    for (const item of items) {
      const parsed = parseCitationLine(item);
      if (parsed) citations.push(parsed);
    }
    cutoff = Math.min(cutoff, citationsAt);
  }

  let limitations: string[] = [];
  const limitationsAt = headingIndex(lines, "Limitations");
  if (limitationsAt >= 0) {
    const { items } = collectBullets(lines, limitationsAt + 1);
    limitations = items.filter((item) => item.length > 0);
    cutoff = Math.min(cutoff, limitationsAt);
  }

  const finalText = lines.slice(0, cutoff).join("\n").trim();
  return {
    // If the model produced nothing but the appendix, keep the original text
    // rather than submitting an empty response -- the validator will reject an
    // empty one, and the operator should see what actually came back.
    finalText: finalText || text.trim(),
    citations,
    limitations,
  };
}

/** Evidence keys mentioned anywhere in the citation list. */
export function citedKeys(citations: ParsedCitation[]): string[] {
  return Array.from(new Set(citations.map((citation) => citation.evidence_key)));
}
