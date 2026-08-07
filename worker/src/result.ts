/**
 * Extracting and validating the participant's answer.
 *
 * The runner writes ``result.json`` inside the sandbox. That file was produced
 * by a language model following a prompt, so this module treats it as a
 * proposal rather than a result: every field is re-typed, every bound
 * re-checked against the lease, and every citation resolved against the
 * bundle's own manifest.
 *
 * The governing decision is what to do with a citation that does not resolve.
 * Dropping it would leave the claim standing in the final text with its
 * support quietly removed, which is worse than either alternative -- the
 * researcher would read a sourced sentence that has no source. Rewriting the
 * text is not this worker's place. So an unresolvable citation fails the
 * attempt, retryably, with a count in the message. The run either produces a
 * result whose citations all resolve, or it produces no result and says why.
 */
import { createHash } from "node:crypto";

import { LIMITS, PROTOCOL_SCHEMA_VERSION } from "./protocol.js";
import type {
  Citation,
  CompletionRequest,
  EvidenceManifest,
  FailureCode,
  JobLimits,
  NodeStatus,
  ResultNode,
  RuntimeReport,
  SupportType,
  ToolLabel,
  UsageReport,
} from "./protocol.js";
import { clampText, safeText } from "./redact.js";
import type { NodeLedger } from "./events.js";

const SUPPORT_TYPES = new Set<SupportType>(["supports", "contradicts", "context", "uncertain"]);
const NODE_STATUSES = new Set<NodeStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const TOOL_LABEL_SET = new Set<ToolLabel>(["Python", "Frozen evidence search"]);

export class ResultRejected extends Error {
  constructor(
    readonly failureCode: FailureCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ResultRejected";
  }
}

export interface ExtractionContext {
  requestSha256: string;
  limits: JobLimits;
  manifest: EvidenceManifest;
  ledger: NodeLedger;
  usage: UsageReport;
  runtime: RuntimeReport;
  /** Per-node usage observed on the event stream, used when the result omits it. */
  nodeUsage: Map<string, UsageReport>;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResultRejected("invalid_result", `${what} was not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readUsage(source: unknown): UsageReport {
  const record =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  return {
    model_call_count: Math.floor(readNumber(record, "model_call_count")),
    input_tokens: Math.floor(readNumber(record, "input_tokens")),
    output_tokens: Math.floor(readNumber(record, "output_tokens")),
    cost_usd: readNumber(record, "cost_usd"),
    pricing_complete: record["pricing_complete"] !== false,
  };
}

function readCitations(
  raw: unknown,
  manifest: EvidenceManifest,
): { citations: Citation[]; unresolved: number } {
  if (!Array.isArray(raw)) return { citations: [], unresolved: 0 };
  const known = new Set(manifest.evidence.map((entry) => entry.evidence_key));
  const citations: Citation[] = [];
  let unresolved = 0;
  for (const item of raw.slice(0, LIMITS.citations)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const key = readString(record, "evidence_key")?.trim();
    if (!key) continue;
    if (!known.has(key)) {
      unresolved += 1;
      continue;
    }
    const supportRaw = readString(record, "support_type");
    const support: SupportType =
      supportRaw && SUPPORT_TYPES.has(supportRaw as SupportType)
        ? (supportRaw as SupportType)
        : "context";
    citations.push({
      evidence_key: key.slice(0, LIMITS.evidenceKey),
      // A locator is a pointer into the researcher's own evidence, so it is
      // clamped but not scrubbed -- "p. 4, /methods" is a legitimate locator
      // that the path pattern would otherwise mangle.
      locator: (() => {
        const locator = readString(record, "locator");
        return locator ? clampText(locator, LIMITS.citationLocator) : null;
      })(),
      claim: clampText(readString(record, "claim") ?? "", LIMITS.citationClaim),
      support_type: support,
    });
  }
  return { citations, unresolved };
}

function readNodes(raw: unknown, context: ExtractionContext): ResultNode[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const nodes: ResultNode[] = [];
  for (const item of raw.slice(0, LIMITS.nodes)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = readString(record, "external_node_id")?.trim();
    if (!id || id.length > LIMITS.externalNodeId) continue;
    if (seen.has(id)) {
      throw new ResultRejected(
        "invalid_result",
        "The result described the same agent twice; the agent tree cannot be reconstructed.",
      );
    }
    seen.add(id);
    // The ledger is the authority on which nodes exist and where they sit. A
    // node the event stream never announced is a node the bounds check never
    // saw, so it is not admitted here either.
    if (!context.ledger.has(id)) continue;
    const statusRaw = readString(record, "status");
    const status: NodeStatus =
      statusRaw && NODE_STATUSES.has(statusRaw as NodeStatus)
        ? (statusRaw as NodeStatus)
        : "completed";
    const toolsRaw = record["tool_labels"];
    const tools: ToolLabel[] = Array.isArray(toolsRaw)
      ? (toolsRaw.filter(
          (label): label is ToolLabel =>
            typeof label === "string" && TOOL_LABEL_SET.has(label as ToolLabel),
        ) as ToolLabel[])
      : [];
    const citedRaw = record["cited_evidence_keys"];
    const known = new Set(context.manifest.evidence.map((entry) => entry.evidence_key));
    const cited = Array.isArray(citedRaw)
      ? citedRaw.filter(
          (key): key is string => typeof key === "string" && known.has(key),
        )
      : [];
    nodes.push({
      external_node_id: id,
      parent_external_node_id: context.ledger.parentOf(id),
      display_name: safeText(record["display_name"], LIMITS.displayName) ?? id,
      status,
      model_key: safeText(record["model_key"], LIMITS.modelKey) ?? null,
      task_summary: safeText(record["task_summary"], LIMITS.taskSummary) ?? null,
      result_summary: safeText(record["result_summary"], LIMITS.resultSummary) ?? null,
      cited_evidence_keys: Array.from(new Set(cited)).slice(0, LIMITS.citations),
      tool_labels: Array.from(new Set(tools)),
      failure_safe_message: safeText(record["failure_safe_message"], LIMITS.failureSafeMessage) ?? null,
      usage: context.nodeUsage.get(id) ?? readUsage(record["usage"]),
    });
  }
  return nodes;
}

/** Bounds that must hold before a result is worth sending. */
function assertWithinBounds(nodes: ResultNode[], context: ExtractionContext): void {
  const snapshot = context.ledger.snapshot();
  if (snapshot.droppedForBounds > 0) {
    throw new ResultRejected(
      "limit_exceeded",
      `The participant tried to create more agents than this meeting allows (` +
        `${snapshot.droppedForBounds} beyond the limit of ${context.limits.max_children} ` +
        `children at depth ${context.limits.max_depth}).`,
    );
  }
  if (nodes.length > context.ledger.maxNodes) {
    throw new ResultRejected(
      "limit_exceeded",
      `The result describes ${nodes.length} agents; this meeting allows at most ${context.ledger.maxNodes}.`,
    );
  }
  for (const node of nodes) {
    if (context.ledger.depthOf(node.external_node_id) > context.limits.max_depth) {
      throw new ResultRejected(
        "limit_exceeded",
        `The participant nested agents deeper than the configured depth of ${context.limits.max_depth}.`,
      );
    }
    if (context.ledger.childCount(node.external_node_id) > context.limits.max_children) {
      throw new ResultRejected(
        "limit_exceeded",
        `One agent created more than the configured maximum of ${context.limits.max_children} children.`,
      );
    }
  }
}

function assertWithinUsage(usage: UsageReport, limits: JobLimits): void {
  const totalTokens = usage.input_tokens + usage.output_tokens;
  if (totalTokens > limits.max_tokens) {
    throw new ResultRejected(
      "limit_exceeded",
      `The turn used ${totalTokens} tokens against a limit of ${limits.max_tokens}.`,
      false,
    );
  }
  if (limits.max_cost_usd !== null && usage.cost_usd > limits.max_cost_usd) {
    throw new ResultRejected(
      "limit_exceeded",
      `The turn cost more than the configured maximum for this meeting.`,
      false,
    );
  }
}

/**
 * Build the completion payload, or refuse.
 *
 * ``raw`` is the parsed ``result.json``. Everything else comes from the lease
 * and the bundle, never from the sandbox: the request hash in particular is
 * taken from the lease, and the sandbox's copy is only compared against it.
 */
export function buildCompletion(raw: unknown, context: ExtractionContext): CompletionRequest {
  const record = asRecord(raw, "The result file");

  const echoed = readString(record, "request_sha256");
  if (!echoed || echoed !== context.requestSha256) {
    // Without this the result of one turn could be attached to another turn of
    // the same meeting -- the server refuses it too, but failing here gives a
    // truthful reason instead of an opaque rejection.
    throw new ResultRejected(
      "invalid_result",
      "The result did not echo this turn's request hash, so it cannot be attached to this turn.",
      false,
    );
  }

  const finalTextRaw = readString(record, "final_text");
  if (!finalTextRaw || finalTextRaw.trim() === "") {
    throw new ResultRejected("invalid_result", "The participant produced no response text.");
  }

  const { citations, unresolved } = readCitations(record["citations"], context.manifest);
  if (unresolved > 0) {
    throw new ResultRejected(
      "invalid_result",
      `${unresolved} citation${unresolved === 1 ? "" : "s"} referenced evidence that is not ` +
        `attached to this meeting. The response was discarded rather than published with ` +
        `unverifiable sources.`,
    );
  }

  const nodes = readNodes(record["nodes"], context);
  assertWithinBounds(nodes, context);
  assertWithinUsage(context.usage, context.limits);

  const limitationsRaw = record["limitations"];
  const limitations = Array.isArray(limitationsRaw)
    ? limitationsRaw
        .filter((item): item is string => typeof item === "string")
        .map((item) => clampText(item.trim(), LIMITS.limitation))
        .filter((item) => item.length > 0)
        .slice(0, LIMITS.limitations)
    : [];

  return {
    schema_version: PROTOCOL_SCHEMA_VERSION,
    request_sha256: context.requestSha256,
    final_text: clampText(finalTextRaw, LIMITS.finalText),
    citations,
    limitations,
    usage: context.usage,
    runtime: context.runtime,
    nodes,
  };
}

/**
 * A stable hash of the submitted result.
 *
 * Logged locally so the operator can match what left their machine against
 * what the studio shows, without either side needing the text.
 */
export function completionFingerprint(completion: CompletionRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        request_sha256: completion.request_sha256,
        final_text: completion.final_text,
        citations: completion.citations,
        nodes: completion.nodes.map((node) => node.external_node_id).sort(),
      }),
    )
    .digest("hex");
}
