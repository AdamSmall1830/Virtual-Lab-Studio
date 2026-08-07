/**
 * The wire contract between this worker and Virtual Lab Studio.
 *
 * These types are a hand-written mirror of the server's worker-facing Pydantic
 * models, deliberately kept in one file so a contract change shows up as a
 * single diff. Nothing here is generated: the worker ships to machines that
 * never see this repository's codegen, and a generated client would drag in a
 * runtime the operator would then have to trust.
 *
 * Two rules govern everything below.
 *
 * 1. The server's allow-list is reproduced here, not approximated. A field the
 *    server would drop is a field this worker must never build, because the
 *    only way to be sure a host path or a reasoning delta does not leave the
 *    operator's machine is to never put it in an outbound object.
 * 2. Every bound the server enforces is repeated here as a constant. The
 *    server rejecting an over-long summary is a wedged worker retrying
 *    forever; clamping locally turns that into a truncated summary.
 */

/** Server-side ``schema_version`` for the worker protocol. */
export const PROTOCOL_SCHEMA_VERSION = "1.0" as const;

/** The single capability profile version 1 of the product supports. */
export const SUPPORTED_PROFILE = "research_read_only" as const;

/** The only skill id reviewed for that profile. */
export const REVIEWED_SKILL_ID = "vls_evidence" as const;

/** This worker's own version, reported as ``adapter_version``. */
export const ADAPTER_VERSION = "0.1.0" as const;

/**
 * The exact upstream agent release this worker is built against.
 *
 * Pinned rather than ranged because the adapter drives a specific published
 * surface, and because a research participant whose behaviour can change under
 * a patch release is not reproducible. Moving this is a deliberate act with a
 * re-run of the smoke test attached.
 */
export const PINNED_AGENT_VERSION = "0.84.0" as const;

// ---------------------------------------------------------------------------
// Field bounds (mirrors of the server's Field(max_length=...) declarations)
// ---------------------------------------------------------------------------

export const LIMITS = {
  taskSummary: 1_000,
  resultSummary: 2_000,
  modelKey: 300,
  failureCategory: 120,
  failureSafeMessage: 300,
  externalNodeId: 120,
  externalEventId: 200,
  displayName: 200,
  eventType: 80,
  finalText: 60_000,
  citationClaim: 4_000,
  citationLocator: 300,
  evidenceKey: 60,
  limitation: 2_000,
  adapterVersion: 60,
  sessionReferenceHash: 64,
  /** Server default; the real value is discovered from a rejected batch. */
  eventBatchMax: 100,
  citations: 200,
  limitations: 50,
  nodes: 200,
} as const;

// ---------------------------------------------------------------------------
// Enrollment and heartbeat
// ---------------------------------------------------------------------------

export type SandboxMode = "docker" | "rootless" | "process";
export type HealthState = "ok" | "degraded" | "error";

export interface ModelPricing {
  input_per_million_usd?: number | null;
  output_per_million_usd?: number | null;
  currency?: string;
}

export interface WorkerModelReport {
  model_key: string;
  display_name: string;
  provider_kind: string;
  context_window: number | null;
  supports_recursive_agents: boolean;
  supports_tools: boolean;
  pricing: ModelPricing;
}

export interface WorkerCapabilitiesReport {
  profiles: string[];
  max_depth: number;
  max_children: number;
  python: boolean;
  web: boolean;
}

/** The self-description a worker may refresh on enroll and on every heartbeat. */
export interface WorkerReport {
  adapter_version: string;
  prime_agent_version: string | null;
  sandbox_mode: SandboxMode;
  capabilities: WorkerCapabilitiesReport;
  model_catalog: WorkerModelReport[];
}

export interface EnrollRequest extends WorkerReport {
  enrollment_token: string;
  display_name: string;
}

export interface EnrolledResponse {
  worker_id: string;
  workspace_id: string;
  display_name: string;
  worker_token: string;
  heartbeat_interval_seconds: number;
  lease_poll_interval_seconds: number;
}

export interface WorkerHealthReport {
  prime_agent: HealthState;
  sandbox: HealthState;
  models: HealthState;
  safe_message: string | null;
}

export interface HeartbeatRequest extends WorkerReport {
  active_job_ids: string[];
  capacity: { max_concurrent_jobs: number; available_slots: number };
  health: WorkerHealthReport;
}

export interface JobControl {
  job_id: string;
  cancel_requested: boolean;
  pause_requested: boolean;
}

export interface HeartbeatResponse {
  worker_id: string;
  status: string;
  heartbeat_interval_seconds: number;
  lease_poll_interval_seconds: number;
  job_controls: JobControl[];
}

// ---------------------------------------------------------------------------
// Leasing
// ---------------------------------------------------------------------------

export interface LeaseRequest {
  available_slots: number;
  supported_profiles: string[];
  model_keys: string[];
}

export interface JobLimits {
  max_children: number;
  max_depth: number;
  max_agent_turns: number;
  max_tokens: number;
  max_runtime_seconds: number;
  max_cost_usd: number | null;
}

export interface LeasedJob {
  job_id: string;
  run_id: string;
  attempt: number;
  request_sha256: string;
  capability_profile: string;
  model_key: string;
  child_model_key: string | null;
  limits: JobLimits;
  allowed_skill_ids: string[];
  lease_expires_at: string;
  heartbeat_interval_seconds: number;
  bundle_url: string;
}

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/**
 * Every event type the server will accept.
 *
 * The three terminal types are listed because the server names them, but they
 * are unreachable from this worker on purpose: terminal state belongs to the
 * completion and failure routes, which validate the result. Emitting
 * ``recursive.job.completed`` as an event would assert an outcome nothing had
 * checked, so {@link isEmittableEventType} refuses them.
 */
export const ALLOWED_EVENT_TYPES = [
  "recursive.job.leased",
  "recursive.job.started",
  "recursive.agent.started",
  "recursive.agent.updated",
  "recursive.agent.completed",
  "recursive.agent.failed",
  "recursive.subagent.started",
  "recursive.subagent.completed",
  "recursive.subagent.failed",
  "recursive.tool.started",
  "recursive.tool.completed",
  "recursive.tool.failed",
  "recursive.usage.updated",
  "recursive.job.completed",
  "recursive.job.failed",
  "recursive.job.cancelled",
] as const;

export type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

const TERMINAL_EVENT_TYPES = new Set<string>([
  "recursive.job.completed",
  "recursive.job.failed",
  "recursive.job.cancelled",
]);

const EMITTABLE = new Set<string>(
  ALLOWED_EVENT_TYPES.filter((t) => !TERMINAL_EVENT_TYPES.has(t)),
);

export function isEmittableEventType(value: string): value is AllowedEventType {
  return EMITTABLE.has(value);
}

/** The only two tool labels the server will render. */
export type ToolLabel = "Python" | "Frozen evidence search";

export type NodeStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface UsageReport {
  model_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  pricing_complete: boolean;
}

export function emptyUsage(): UsageReport {
  return {
    model_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    pricing_complete: true,
  };
}

export interface EventNodeRef {
  external_node_id: string;
  parent_external_node_id: string | null;
  display_name: string;
}

export interface EventPayload {
  task_summary?: string;
  result_summary?: string;
  model_key?: string;
  tool_label?: ToolLabel;
  node_status?: NodeStatus;
  failure_category?: string;
  failure_safe_message?: string;
  usage?: UsageReport;
}

export interface WorkerEvent {
  external_event_id: string;
  worker_sequence: number;
  occurred_at: string;
  type: AllowedEventType;
  node?: EventNodeRef;
  payload: EventPayload;
}

export interface EventBatch {
  schema_version: typeof PROTOCOL_SCHEMA_VERSION;
  events: WorkerEvent[];
}

export interface EventBatchAck {
  accepted: number;
  duplicates: number;
  rejected: number;
}

// ---------------------------------------------------------------------------
// Completion and failure
// ---------------------------------------------------------------------------

export type SupportType = "supports" | "contradicts" | "context" | "uncertain";

export interface Citation {
  evidence_key: string;
  locator: string | null;
  claim: string;
  support_type: SupportType;
}

export interface ResultNode {
  external_node_id: string;
  parent_external_node_id: string | null;
  display_name: string;
  status: NodeStatus;
  model_key: string | null;
  task_summary: string | null;
  result_summary: string | null;
  cited_evidence_keys: string[];
  tool_labels: ToolLabel[];
  failure_safe_message: string | null;
  usage: UsageReport;
}

export interface RuntimeReport {
  adapter_version: string | null;
  prime_agent_version: string | null;
  model_key: string | null;
  child_model_key: string | null;
  elapsed_ms: number;
  is_simulation: boolean;
  /** A hash, never a path. Correlates with the operator's own logs only. */
  session_reference_hash: string | null;
}

export interface CompletionRequest {
  schema_version: typeof PROTOCOL_SCHEMA_VERSION;
  request_sha256: string;
  final_text: string;
  citations: Citation[];
  limitations: string[];
  usage: UsageReport;
  runtime: RuntimeReport;
  nodes: ResultNode[];
}

/**
 * The closed failure vocabulary.
 *
 * Free text is not an option: a failure reason is rendered to the researcher
 * and stored in the provenance record, so it must not be able to carry a stack
 * trace, a host path or a provider error body.
 */
export type FailureCode =
  | "worker_error"
  | "model_error"
  | "sandbox_error"
  | "timeout"
  | "limit_exceeded"
  | "invalid_result"
  | "cancelled"
  | "paused";

export interface FailRequest {
  failure_code: FailureCode;
  safe_message: string;
  retryable: boolean;
  usage: UsageReport;
}

export interface JobAck {
  job_id: string;
  status: string;
  accepted: boolean;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface EvidenceManifestEntry {
  evidence_key: string;
  file: string;
  title: string | null;
  citation: string | null;
  content_sha256: string | null;
  chunk_count: number;
  truncated: boolean;
  trust: string;
}

export interface EvidenceManifest {
  schema_version: string;
  job_id: string;
  request_sha256: string;
  meeting_definition_sha256: string;
  evidence: EvidenceManifestEntry[];
}
