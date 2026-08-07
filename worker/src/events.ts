/**
 * Turning runner chatter into the sixteen events the server accepts.
 *
 * This is the second half of the sandbox boundary. The runner's stream is
 * produced by a process that has just executed model-generated Python, so
 * three things happen here and nowhere else.
 *
 * *Bounds are counted on the host.* The job's ``max_children`` and
 * ``max_depth`` are stated in the brief, but a prompt is a request, not a
 * control. A coordinator that ignores them -- because the model drifted,
 * because evidence contained an injection, or because the runner was replaced
 * -- is stopped by this counter. Nodes past the bound are dropped from the
 * stream, and the same counter refuses the result in result.ts, so the
 * researcher never sees a tree wider than the experiment they configured.
 *
 * *Text is scrubbed.* Summaries pass through redact() before they are put in
 * an outbound object.
 *
 * *Volume is coalesced.* An agent emits progress far faster than a research
 * record needs. Lifecycle transitions always survive; repeated "still working"
 * updates for the same node collapse to one every few seconds.
 */
import { LIMITS, isEmittableEventType } from "./protocol.js";
import type {
  AllowedEventType,
  EventNodeRef,
  EventPayload,
  JobLimits,
  ToolLabel,
  UsageReport,
  WorkerEvent,
} from "./protocol.js";
import { safeText } from "./redact.js";
import type { RunnerEvent } from "./runtime-events.js";

/** How often a single node may report unchanged progress. */
const PROGRESS_COALESCE_MS = 3_000;

/**
 * How many events may wait for delivery.
 *
 * When the server is unreachable the queue must not grow without limit. Once
 * full, progress updates are shed before lifecycle events: losing "node 3 is
 * still thinking" costs nothing, losing "node 3 finished" corrupts the tree.
 */
const MAX_QUEUE = 2_000;

const TOOL_LABELS: Record<string, ToolLabel> = {
  python: "Python",
  evidence_search: "Frozen evidence search",
};

export interface NodeBoundsSnapshot {
  nodeCount: number;
  maxDepthSeen: number;
  droppedForBounds: number;
}

/**
 * The authoritative node ledger for one job.
 *
 * Depth is derived from the parent chain the runner reports rather than from
 * the ``depth`` field it sends, so a runner cannot understate how deep it went
 * by lying about one number.
 */
export class NodeLedger {
  private readonly parents = new Map<string, string | null>();
  private readonly depths = new Map<string, number>();
  private dropped = 0;

  constructor(private readonly limits: JobLimits) {}

  /** The coordinator plus its permitted descendants. */
  get maxNodes(): number {
    return this.limits.max_children * Math.max(1, this.limits.max_depth) + 1;
  }

  get size(): number {
    return this.parents.size;
  }

  has(nodeId: string): boolean {
    return this.parents.has(nodeId);
  }

  depthOf(nodeId: string): number {
    return this.depths.get(nodeId) ?? 0;
  }

  snapshot(): NodeBoundsSnapshot {
    let maxDepth = 0;
    for (const depth of this.depths.values()) maxDepth = Math.max(maxDepth, depth);
    return { nodeCount: this.parents.size, maxDepthSeen: maxDepth, droppedForBounds: this.dropped };
  }

  /**
   * Admit a node, or refuse it.
   *
   * Refusal reasons are distinguished because they mean different things to
   * the researcher: a fan-out breach and a depth breach are different
   * experimental failures.
   */
  admit(
    nodeId: string,
    parentId: string | null,
  ): { ok: true; depth: number } | { ok: false; reason: "count" | "depth" | "cycle" } {
    if (this.parents.has(nodeId)) {
      return { ok: true, depth: this.depths.get(nodeId) ?? 0 };
    }
    const parent = parentId && parentId !== nodeId ? parentId : null;
    if (parent !== null && !this.parents.has(parent)) {
      // A child whose parent was never announced cannot be placed in the tree,
      // and admitting it would let a runner sidestep the depth check by
      // omitting intermediate nodes.
      this.dropped += 1;
      return { ok: false, reason: "cycle" };
    }
    const depth = parent === null ? 0 : (this.depths.get(parent) ?? 0) + 1;
    if (depth > this.limits.max_depth) {
      this.dropped += 1;
      return { ok: false, reason: "depth" };
    }
    if (this.parents.size >= this.maxNodes) {
      this.dropped += 1;
      return { ok: false, reason: "count" };
    }
    this.parents.set(nodeId, parent);
    this.depths.set(nodeId, depth);
    return { ok: true, depth };
  }

  parentOf(nodeId: string): string | null {
    return this.parents.get(nodeId) ?? null;
  }

  /** Direct children of a node, used to check fan-out at result time. */
  childCount(nodeId: string): number {
    let count = 0;
    for (const parent of this.parents.values()) if (parent === nodeId) count += 1;
    return count;
  }
}

export interface NormalizerOptions {
  jobId: string;
  limits: JobLimits;
  now?: () => number;
}

/**
 * Accumulated usage as reported by the runner.
 *
 * Kept separately from the events so the final completion can carry a total
 * even when individual usage events were coalesced away.
 */
export interface UsageAccumulator {
  total: UsageReport;
  perNode: Map<string, UsageReport>;
}

function addUsage(target: UsageReport, delta: UsageReport): void {
  target.model_call_count += delta.model_call_count;
  target.input_tokens += delta.input_tokens;
  target.output_tokens += delta.output_tokens;
  target.cost_usd = Number((target.cost_usd + delta.cost_usd).toFixed(6));
  target.pricing_complete = target.pricing_complete && delta.pricing_complete;
}

function readUsage(raw: Record<string, unknown>): UsageReport {
  const number = (key: string): number => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    model_call_count: Math.floor(number("model_call_count")),
    input_tokens: Math.floor(number("input_tokens")),
    output_tokens: Math.floor(number("output_tokens")),
    cost_usd: number("cost_usd"),
    pricing_complete: raw["pricing_complete"] !== false,
  };
}

function nodeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.externalNodeId) return null;
  // Node ids reach the browser and the export as identifiers. Keeping them to
  // a conservative class means they cannot smuggle markup or control bytes.
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

export class EventNormalizer {
  readonly ledger: NodeLedger;
  readonly usage: UsageAccumulator = {
    total: {
      model_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      pricing_complete: true,
    },
    perNode: new Map(),
  };

  /** Result summaries reported per node, reused when building result nodes. */
  readonly nodeSummaries = new Map<
    string,
    { display_name: string; task_summary?: string; result_summary?: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; model_key?: string; tools: Set<ToolLabel>; failure?: string; cited: Set<string> }
  >();

  private readonly queue: WorkerEvent[] = [];
  private readonly lastProgressAt = new Map<string, number>();
  private sequence = 0;
  private droppedForQueue = 0;
  private readonly now: () => number;

  constructor(private readonly options: NormalizerOptions) {
    this.ledger = new NodeLedger(options.limits);
    this.now = options.now ?? Date.now;
  }

  get pending(): number {
    return this.queue.length;
  }

  get dropped(): number {
    return this.droppedForQueue;
  }

  /** Take up to ``limit`` events for delivery, leaving them queued on failure. */
  peek(limit: number): WorkerEvent[] {
    return this.queue.slice(0, limit);
  }

  /** Discard events the server acknowledged. */
  ack(count: number): void {
    this.queue.splice(0, count);
  }

  /** A lifecycle event the researcher should always see. */
  private push(event: WorkerEvent, sheddable: boolean): void {
    if (this.queue.length >= MAX_QUEUE) {
      const victim = this.queue.findIndex((e) => e.type === "recursive.agent.updated");
      if (victim >= 0) {
        this.queue.splice(victim, 1);
        this.droppedForQueue += 1;
      } else if (sheddable) {
        this.droppedForQueue += 1;
        return;
      } else {
        this.queue.shift();
        this.droppedForQueue += 1;
      }
    }
    this.queue.push(event);
  }

  private build(
    type: AllowedEventType,
    node: EventNodeRef | undefined,
    payload: EventPayload,
  ): WorkerEvent {
    this.sequence += 1;
    return {
      // Stable for the life of the job, so a retried batch dedupes on the
      // server rather than appearing twice in the run stream.
      external_event_id: `${this.options.jobId}:${this.sequence}`,
      worker_sequence: this.sequence,
      occurred_at: new Date(this.now()).toISOString(),
      type,
      ...(node ? { node } : {}),
      payload,
    };
  }

  private track(id: string, display: string): NonNullable<ReturnType<typeof this.nodeSummaries.get>> {
    let entry = this.nodeSummaries.get(id);
    if (!entry) {
      entry = { display_name: display, status: "queued", tools: new Set(), cited: new Set() };
      this.nodeSummaries.set(id, entry);
    }
    return entry;
  }

  /** Emit the "this job is running" marker, before any node exists. */
  jobStarted(modelKey: string): void {
    this.push(this.build("recursive.job.started", undefined, { model_key: safeText(modelKey, LIMITS.modelKey) }), false);
  }

  /**
   * Absorb one runner event.
   *
   * Returns a bounds violation when the runner exceeded what the job allows,
   * so the caller can decide to abort the attempt rather than let it run on.
   */
  ingest(raw: RunnerEvent): { boundsViolation?: "count" | "depth" } {
    const record = raw as unknown as Record<string, unknown>;
    switch (raw.kind) {
      case "node.started": {
        const id = nodeId(record["node_id"]);
        if (!id) return {};
        const parent = nodeId(record["parent_node_id"]);
        const admitted = this.ledger.admit(id, parent);
        if (!admitted.ok) {
          return admitted.reason === "cycle" ? {} : { boundsViolation: admitted.reason };
        }
        const display =
          safeText(record["display_name"], LIMITS.displayName) ?? id;
        const entry = this.track(id, display);
        entry.status = "running";
        entry.display_name = display;
        const task = safeText(record["task_summary"], LIMITS.taskSummary);
        if (task) entry.task_summary = task;
        const model = safeText(record["model_key"], LIMITS.modelKey);
        if (model) entry.model_key = model;
        const isChild = this.ledger.parentOf(id) !== null;
        this.push(
          this.build(
            isChild ? "recursive.subagent.started" : "recursive.agent.started",
            { external_node_id: id, parent_external_node_id: this.ledger.parentOf(id), display_name: display },
            { ...(task ? { task_summary: task } : {}), ...(model ? { model_key: model } : {}) },
          ),
          false,
        );
        return {};
      }
      case "node.progress": {
        const id = nodeId(record["node_id"]);
        if (!id || !this.ledger.has(id)) return {};
        const last = this.lastProgressAt.get(id);
        const entry = this.track(id, id);
        const task = safeText(record["task_summary"], LIMITS.taskSummary);
        const result = safeText(record["result_summary"], LIMITS.resultSummary);
        if (task) entry.task_summary = task;
        if (result) entry.result_summary = result;
        // The first sign of life from a node always goes out. Only the stream
        // after it is throttled, so a researcher watching the tree sees an
        // agent start working immediately rather than three seconds later.
        if (last !== undefined && this.now() - last < PROGRESS_COALESCE_MS) return {};
        this.lastProgressAt.set(id, this.now());
        this.push(
          this.build(
            "recursive.agent.updated",
            {
              external_node_id: id,
              parent_external_node_id: this.ledger.parentOf(id),
              display_name: entry.display_name,
            },
            { ...(task ? { task_summary: task } : {}), ...(result ? { result_summary: result } : {}) },
          ),
          true,
        );
        return {};
      }
      case "node.completed": {
        const id = nodeId(record["node_id"]);
        if (!id || !this.ledger.has(id)) return {};
        const entry = this.track(id, id);
        entry.status = "completed";
        const result = safeText(record["result_summary"], LIMITS.resultSummary);
        if (result) entry.result_summary = result;
        const cited = record["cited_evidence_keys"];
        if (Array.isArray(cited)) {
          for (const key of cited.slice(0, LIMITS.citations)) {
            if (typeof key === "string" && key.length <= LIMITS.evidenceKey) entry.cited.add(key);
          }
        }
        const isChild = this.ledger.parentOf(id) !== null;
        this.push(
          this.build(
            isChild ? "recursive.subagent.completed" : "recursive.agent.completed",
            {
              external_node_id: id,
              parent_external_node_id: this.ledger.parentOf(id),
              display_name: entry.display_name,
            },
            { ...(result ? { result_summary: result } : {}) },
          ),
          false,
        );
        return {};
      }
      case "node.failed": {
        const id = nodeId(record["node_id"]);
        if (!id || !this.ledger.has(id)) return {};
        const entry = this.track(id, id);
        entry.status = "failed";
        const category = safeText(record["failure_category"], LIMITS.failureCategory);
        const message = safeText(record["message"], LIMITS.failureSafeMessage);
        if (message) entry.failure = message;
        const isChild = this.ledger.parentOf(id) !== null;
        this.push(
          this.build(
            isChild ? "recursive.subagent.failed" : "recursive.agent.failed",
            {
              external_node_id: id,
              parent_external_node_id: this.ledger.parentOf(id),
              display_name: entry.display_name,
            },
            {
              ...(category ? { failure_category: category } : {}),
              ...(message ? { failure_safe_message: message } : {}),
            },
          ),
          false,
        );
        return {};
      }
      case "tool.started":
      case "tool.completed":
      case "tool.failed": {
        const id = nodeId(record["node_id"]);
        if (!id || !this.ledger.has(id)) return {};
        const toolName = typeof record["tool"] === "string" ? record["tool"] : "";
        const label = TOOL_LABELS[toolName];
        // Only the two reviewed tools have a label the server will render. A
        // tool outside the capability profile is not renamed to fit -- it is
        // dropped, and the researcher sees no tool activity for it.
        if (!label) return {};
        const entry = this.track(id, id);
        entry.tools.add(label);
        const type: AllowedEventType =
          raw.kind === "tool.started"
            ? "recursive.tool.started"
            : raw.kind === "tool.completed"
              ? "recursive.tool.completed"
              : "recursive.tool.failed";
        const message = safeText(record["message"], LIMITS.failureSafeMessage);
        this.push(
          this.build(
            type,
            {
              external_node_id: id,
              parent_external_node_id: this.ledger.parentOf(id),
              display_name: entry.display_name,
            },
            { tool_label: label, ...(message ? { failure_safe_message: message } : {}) },
          ),
          raw.kind !== "tool.failed",
        );
        return {};
      }
      case "usage": {
        const delta = readUsage(record);
        addUsage(this.usage.total, delta);
        const id = nodeId(record["node_id"]);
        if (id && this.ledger.has(id)) {
          const existing = this.usage.perNode.get(id) ?? {
            model_call_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            pricing_complete: true,
          };
          addUsage(existing, delta);
          this.usage.perNode.set(id, existing);
        }
        this.push(
          this.build("recursive.usage.updated", undefined, { usage: { ...this.usage.total } }),
          true,
        );
        return {};
      }
      default:
        // runner.ready and diagnostic never leave the operator's machine.
        return {};
    }
  }
}

/** Exported for tests: the server's own guard, mirrored. */
export function assertEmittable(type: string): asserts type is AllowedEventType {
  if (!isEmittableEventType(type)) {
    throw new Error(`Refusing to emit ${type}: terminal state belongs to the result routes.`);
  }
}
