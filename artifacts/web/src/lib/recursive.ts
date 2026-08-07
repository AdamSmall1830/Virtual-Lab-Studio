// Presentation rules for recursive (RLM) execution.
//
// This module is deliberately pure: every decision the recursive UI makes
// about availability, wording, status and tree shape lives here so it can be
// unit-tested without a DOM. The components below it only render what these
// functions return.
//
// Three product rules are encoded here rather than left to each component:
//
//  1. A recursive participant is never silently converted back to standard.
//     `availabilityBlocker` returns a *blocker*, not a fallback.
//  2. Recursive figures are ceilings, not predictions. Every helper that
//     formats a limit says so in the label it returns.
//  3. Status is never carried by colour alone. Every presentation returns a
//     text label and an icon; the `tone` is decoration on top of those.

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
  PauseCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  RecursiveAgentJobOut,
  RecursiveAgentNodeOut,
  RecursiveWorkerModelOut,
  RecursiveWorkerOut,
  RunEventOut,
} from '@/api';

// ---------------------------------------------------------------------------
// Worker liveness
// ---------------------------------------------------------------------------

/**
 * How long after its last check-in a worker stops counting as online.
 *
 * This mirrors the server's `recursive_worker_offline_after_seconds` default.
 * It is a *display* heuristic only — the server re-decides eligibility when a
 * draft is validated and again when a job is dispatched, so a client that is
 * out of step can never launch something the server would refuse. Every
 * surface that uses it also shows the raw last-contact time, so the researcher
 * can see the underlying fact rather than only our interpretation of it.
 */
export const WORKER_OFFLINE_AFTER_SECONDS = 90;

const DEAD_STATUSES = new Set(['disabled', 'revoked', 'offline']);

export function workerIsOnline(
  worker: RecursiveWorkerOut,
  now: number = Date.now(),
): boolean {
  if (!worker.enabled || worker.revoked_at) return false;
  if (DEAD_STATUSES.has(worker.status)) return false;
  if (!worker.last_seen_at) return false;
  const seen = Date.parse(worker.last_seen_at);
  if (Number.isNaN(seen)) return false;
  return now - seen <= WORKER_OFFLINE_AFTER_SECONDS * 1000;
}

/** Models a worker advertises as usable for recursive coordination. */
export function recursiveModels(worker: RecursiveWorkerOut): RecursiveWorkerModelOut[] {
  return (worker.model_catalog ?? []).filter((m) => m.supports_recursive_agents === true);
}

/** True when both token prices are known, so a cost ceiling can be stated. */
export function modelPricingComplete(model: RecursiveWorkerModelOut): boolean {
  const p = model.pricing;
  if (!p) return false;
  return p.input_usd_per_1m != null && p.output_usd_per_1m != null;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface EligibleWorker {
  worker: RecursiveWorkerOut;
  models: RecursiveWorkerModelOut[];
}

export type RecursiveAvailability =
  | { state: 'loading' }
  /** The deployment does not run the recursive runtime at all. */
  | { state: 'unsupported'; headline: string; detail: string }
  | { state: 'forbidden'; headline: string; detail: string }
  | { state: 'error'; headline: string; detail: string }
  | { state: 'no_workers'; headline: string; detail: string }
  | { state: 'offline'; headline: string; detail: string; workers: RecursiveWorkerOut[] }
  | { state: 'no_model'; headline: string; detail: string; workers: RecursiveWorkerOut[] }
  | { state: 'ready'; workers: EligibleWorker[] };

export function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

export interface AvailabilityInput {
  isLoading: boolean;
  error?: unknown;
  workers?: RecursiveWorkerOut[];
  now?: number;
}

/**
 * Decide, from the workers list alone, whether a recursive participant can be
 * configured — and if not, exactly why.
 *
 * The server unregisters the whole recursive router when the feature flag is
 * off, so a 404 on this route means "not enabled here" rather than "no such
 * workspace". That is what lets one query distinguish all of the disabled
 * reasons without a separate capability endpoint.
 */
export function recursiveAvailability(input: AvailabilityInput): RecursiveAvailability {
  const { isLoading, error, workers, now = Date.now() } = input;
  if (error) {
    const status = errorStatus(error);
    if (status === 404) {
      return {
        state: 'unsupported',
        headline: 'Recursive execution is not enabled on this deployment',
        detail:
          'This installation of Virtual Lab Studio runs without the recursive agent runtime. ' +
          'Every participant runs as a standard agent.',
      };
    }
    if (status === 401 || status === 403) {
      return {
        state: 'forbidden',
        headline: 'You cannot manage recursive workers in this workspace',
        detail: 'Ask a workspace administrator to enrol and manage the bridge machines.',
      };
    }
    return {
      state: 'error',
      headline: 'Could not check for recursive workers',
      detail: 'The worker list could not be loaded, so recursive execution is unavailable.',
    };
  }
  if (isLoading || workers === undefined) return { state: 'loading' };

  const live = workers.filter((w) => !w.revoked_at);
  if (live.length === 0) {
    return {
      state: 'no_workers',
      headline: 'No recursive worker is enrolled',
      detail:
        'A recursive participant runs on a machine you control. Enrol that machine under ' +
        'Settings → Recursive workers, then start the bridge on it.',
    };
  }

  const online = live.filter((w) => workerIsOnline(w, now));
  if (online.length === 0) {
    return {
      state: 'offline',
      headline: 'No recursive worker is online',
      detail:
        'Your workspace has an enrolled worker, but none has checked in recently. Start the ' +
        'bridge on that machine and wait for it to report in.',
      workers: live,
    };
  }

  const eligible: EligibleWorker[] = online
    .map((worker) => ({ worker, models: recursiveModels(worker) }))
    .filter((e) => e.models.length > 0);

  if (eligible.length === 0) {
    return {
      state: 'no_model',
      headline: 'No compatible model is advertised',
      detail:
        'The online worker reports no model that supports recursive agents. Pull or configure ' +
        'such a model on that machine; the worker publishes its catalogue on the next check-in.',
      workers: online,
    };
  }

  return { state: 'ready', workers: eligible };
}

/**
 * The single sentence to show on a participant that asked for recursive
 * execution while the runtime is unavailable.
 *
 * Returns null when recursive execution can proceed. It never returns a
 * suggestion to fall back: converting the participant is the researcher's
 * decision to make explicitly, because a standard agent runs a materially
 * different experiment.
 */
export function availabilityBlocker(availability: RecursiveAvailability): string | null {
  switch (availability.state) {
    case 'ready':
      return null;
    case 'loading':
      return 'Checking whether a recursive worker is available…';
    default:
      return availability.headline;
  }
}

// ---------------------------------------------------------------------------
// Configuration bounds — mirrors RecursiveExecutionConfigIn
// ---------------------------------------------------------------------------

export const RECURSIVE_BOUNDS = {
  max_children: { min: 1, max: 8, default: 3 },
  max_depth: { min: 1, max: 2, default: 1 },
  max_agent_turns: { min: 1, max: 20, default: 8 },
  max_tokens: { min: 1024, max: 1_000_000, default: 32_000 },
  max_runtime_seconds: { min: 60, max: 3600, default: 900 },
  max_cost_usd: { min: 0, max: 1000, default: 2 },
} as const;

export type RecursiveBoundKey = keyof typeof RECURSIVE_BOUNDS;

export interface RecursiveDraftConfig {
  requested_worker_id: string;
  coordinator_model_key: string;
  child_model_key: string | null;
  max_children: number;
  max_depth: number;
  max_agent_turns: number;
  max_tokens: number;
  max_runtime_seconds: number;
  max_cost_usd: number | null;
}

/**
 * A fresh recursive configuration.
 *
 * The worker and model default to empty rather than to "whatever is online":
 * an unselected seat must surface as a blocker the researcher resolves, not as
 * a silent choice made on their behalf.
 */
export function defaultRecursiveConfig(
  workerId = '',
  coordinatorModelKey = '',
): RecursiveDraftConfig {
  return {
    requested_worker_id: workerId,
    coordinator_model_key: coordinatorModelKey,
    child_model_key: null,
    max_children: RECURSIVE_BOUNDS.max_children.default,
    max_depth: RECURSIVE_BOUNDS.max_depth.default,
    max_agent_turns: RECURSIVE_BOUNDS.max_agent_turns.default,
    max_tokens: RECURSIVE_BOUNDS.max_tokens.default,
    max_runtime_seconds: RECURSIVE_BOUNDS.max_runtime_seconds.default,
    max_cost_usd: RECURSIVE_BOUNDS.max_cost_usd.default,
  };
}

export function clampBound(key: RecursiveBoundKey, value: number): number {
  const b = RECURSIVE_BOUNDS[key];
  if (!Number.isFinite(value)) return b.default;
  return Math.min(b.max, Math.max(b.min, Math.round(value)));
}

/**
 * Local checks that mirror the ones the server will apply on validate.
 *
 * These exist to explain a problem before a round-trip, never to replace the
 * server's answer: the launch path always re-validates.
 */
export function recursiveConfigProblems(
  config: RecursiveDraftConfig,
  eligible: EligibleWorker[],
): string[] {
  const problems: string[] = [];
  const chosen = eligible.find((e) => e.worker.id === config.requested_worker_id);
  if (!chosen) {
    problems.push('Select an online worker that advertises a recursive-capable model.');
    return problems;
  }
  const keys = new Set(chosen.models.map((m) => m.model_key));
  if (!config.coordinator_model_key || !keys.has(config.coordinator_model_key)) {
    problems.push(
      `Choose a coordinator model that “${chosen.worker.display_name}” currently advertises.`,
    );
  }
  if (config.child_model_key && !keys.has(config.child_model_key)) {
    problems.push(
      `Choose a child model that “${chosen.worker.display_name}” currently advertises.`,
    );
  }
  const caps = chosen.worker.capabilities ?? {};
  if (typeof caps.max_children === 'number' && config.max_children > caps.max_children) {
    problems.push(
      `“${chosen.worker.display_name}” accepts at most ${caps.max_children} child agents.`,
    );
  }
  if (typeof caps.max_depth === 'number' && config.max_depth > caps.max_depth) {
    problems.push(`“${chosen.worker.display_name}” accepts a maximum depth of ${caps.max_depth}.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Status presentation — icon + words, never colour alone
// ---------------------------------------------------------------------------

export type StatusTone = 'neutral' | 'active' | 'good' | 'warn' | 'bad';

export interface StatusPresentation {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
  /** True when the icon should spin. */
  busy?: boolean;
}

const NODE_STATUS: Record<string, StatusPresentation> = {
  queued: { label: 'Queued', icon: CircleDashed, tone: 'neutral' },
  running: { label: 'Running', icon: Loader2, tone: 'active', busy: true },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'good' },
  failed: { label: 'Failed', icon: XCircle, tone: 'bad' },
  cancelled: { label: 'Cancelled', icon: CircleSlash, tone: 'neutral' },
};

const JOB_STATUS: Record<string, StatusPresentation> = {
  queued: { label: 'Queued', icon: CircleDashed, tone: 'neutral' },
  leased: { label: 'Picked up by worker', icon: Loader2, tone: 'active', busy: true },
  running: { label: 'Running', icon: Loader2, tone: 'active', busy: true },
  cancellation_requested: { label: 'Cancelling', icon: PauseCircle, tone: 'warn' },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'good' },
  failed: { label: 'Failed', icon: XCircle, tone: 'bad' },
  cancelled: { label: 'Cancelled', icon: CircleSlash, tone: 'neutral' },
};

const WORKER_STATUS: Record<string, StatusPresentation> = {
  online: { label: 'Online', icon: CheckCircle2, tone: 'good' },
  degraded: { label: 'Degraded', icon: AlertTriangle, tone: 'warn' },
  offline: { label: 'Offline', icon: CircleDashed, tone: 'neutral' },
  disabled: { label: 'Disabled', icon: Ban, tone: 'warn' },
  revoked: { label: 'Revoked', icon: CircleSlash, tone: 'bad' },
};

function lookup(
  table: Record<string, StatusPresentation>,
  status: string | null | undefined,
): StatusPresentation {
  if (status && table[status]) return table[status];
  return {
    label: humanise(status ?? 'unknown'),
    icon: CircleDashed,
    tone: 'neutral',
  };
}

export function humanise(value: string): string {
  const spaced = value.replace(/[_.]/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

export const nodeStatusPresentation = (s: string | null | undefined) => lookup(NODE_STATUS, s);
export const jobStatusPresentation = (s: string | null | undefined) => lookup(JOB_STATUS, s);

/**
 * How a worker reads to a human right now.
 *
 * A worker whose row still says "online" but which stopped checking in is
 * reported as stale rather than online: the stored status is only refreshed by
 * the worker itself, so a machine that lost power leaves a stale value behind.
 */
export function workerStatusPresentation(
  worker: RecursiveWorkerOut,
  now: number = Date.now(),
): StatusPresentation {
  if (worker.revoked_at) return WORKER_STATUS.revoked;
  if (!worker.enabled) return WORKER_STATUS.disabled;
  if (!workerIsOnline(worker, now)) {
    return {
      label: worker.last_seen_at ? 'Not responding' : 'Never checked in',
      icon: AlertTriangle,
      tone: 'warn',
    };
  }
  return lookup(WORKER_STATUS, worker.status);
}

// Only tokens that exist in the theme, plus Tailwind's built-in palette for
// the two states the design system has no token for.
export const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground border-border bg-muted/30',
  active: 'text-primary border-primary/40 bg-primary/10',
  good: 'text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
  warn: 'text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10',
  bad: 'text-destructive border-destructive/40 bg-destructive/10',
};

// ---------------------------------------------------------------------------
// Tree assembly
// ---------------------------------------------------------------------------

export interface TreeNode {
  node: RecursiveAgentNodeOut;
  depth: number;
  children: TreeNode[];
}

/**
 * Turn a flat node list into a forest.
 *
 * Nodes arrive out of order and a parent may not have been reported yet, so a
 * node whose parent is unknown is surfaced as a root rather than dropped —
 * hiding reported work would misrepresent what the run actually did. Cycles
 * (which a buggy worker could report) are broken by only ever attaching a node
 * once.
 */
export function buildNodeTree(nodes: RecursiveAgentNodeOut[]): TreeNode[] {
  const byExternalId = new Map<string, RecursiveAgentNodeOut>();
  for (const node of nodes) {
    if (!byExternalId.has(node.external_node_id)) byExternalId.set(node.external_node_id, node);
  }

  const wrapped = new Map<string, TreeNode>();
  for (const node of byExternalId.values()) {
    wrapped.set(node.external_node_id, { node, depth: 0, children: [] });
  }

  const roots: TreeNode[] = [];
  const attached = new Set<string>();

  for (const entry of wrapped.values()) {
    const parentId = entry.node.parent_external_node_id;
    const parent = parentId ? wrapped.get(parentId) : undefined;
    if (!parent || parent === entry) {
      roots.push(entry);
      attached.add(entry.node.external_node_id);
      continue;
    }
    // Detect a cycle before attaching: walk up from the intended parent.
    let cursor: TreeNode | undefined = parent;
    const seen = new Set<string>([entry.node.external_node_id]);
    let cyclic = false;
    while (cursor) {
      if (seen.has(cursor.node.external_node_id)) {
        cyclic = true;
        break;
      }
      seen.add(cursor.node.external_node_id);
      const nextId: string | null = cursor.node.parent_external_node_id;
      cursor = nextId ? wrapped.get(nextId) : undefined;
    }
    if (cyclic) {
      roots.push(entry);
      attached.add(entry.node.external_node_id);
      continue;
    }
    parent.children.push(entry);
    attached.add(entry.node.external_node_id);
  }

  const orderKey = (t: TreeNode) => t.node.started_at ?? t.node.external_node_id;
  const assignDepth = (entry: TreeNode, depth: number) => {
    entry.depth = depth;
    entry.children.sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
    for (const child of entry.children) assignDepth(child, depth + 1);
  };
  roots.sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

export interface TreeTotals {
  nodeCount: number;
  running: number;
  completed: number;
  failed: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  maxDepthSeen: number;
}

export function summariseNodes(nodes: RecursiveAgentNodeOut[]): TreeTotals {
  const totals: TreeTotals = {
    nodeCount: nodes.length,
    running: 0,
    completed: 0,
    failed: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    maxDepthSeen: 0,
  };
  for (const n of nodes) {
    if (n.status === 'running') totals.running += 1;
    else if (n.status === 'completed') totals.completed += 1;
    else if (n.status === 'failed') totals.failed += 1;
    totals.modelCalls += n.model_call_count ?? 0;
    totals.inputTokens += n.input_tokens ?? 0;
    totals.outputTokens += n.output_tokens ?? 0;
    totals.costUsd += Number(n.cost_usd ?? 0);
  }
  for (const root of buildNodeTree(nodes)) {
    const walk = (t: TreeNode) => {
      totals.maxDepthSeen = Math.max(totals.maxDepthSeen, t.depth);
      t.children.forEach(walk);
    };
    walk(root);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

export function isRecursiveEvent(eventType: string): boolean {
  return eventType.startsWith('recursive.') || eventType === 'run.waiting_external';
}

const EVENT_LABELS: Record<string, string> = {
  'recursive.job.queued': 'Recursive turn queued',
  'recursive.job.leased': 'Worker picked up the turn',
  'recursive.job.started': 'Recursive turn started',
  'recursive.job.completed': 'Recursive turn completed',
  'recursive.job.failed': 'Recursive turn failed',
  'recursive.job.cancelled': 'Recursive turn cancelled',
  'recursive.job.released': 'Worker released the turn',
  'recursive.job.retry_scheduled': 'Recursive turn will be retried',
  'recursive.agent.started': 'Agent started',
  'recursive.agent.updated': 'Agent progress',
  'recursive.agent.completed': 'Agent completed',
  'recursive.agent.failed': 'Agent failed',
  'recursive.subagent.started': 'Sub-agent started',
  'recursive.subagent.completed': 'Sub-agent completed',
  'recursive.subagent.failed': 'Sub-agent failed',
  'recursive.tool.started': 'Tool started',
  'recursive.tool.completed': 'Tool finished',
  'recursive.tool.failed': 'Tool failed',
  'recursive.usage.updated': 'Usage updated',
  'run.waiting_external': 'Waiting for the external worker',
};

export interface RecursiveActivity {
  id: number;
  at: string;
  label: string;
  nodeName: string | null;
  detail: string | null;
  tone: StatusTone;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Render one run event as a line of recursive activity.
 *
 * Only the fields the server's allow-list can produce are read. Anything else
 * a payload happens to carry is ignored rather than displayed, so a future
 * server-side addition cannot leak coordinator reasoning, a host path or a
 * credential into the browser by accident.
 */
export function describeRecursiveEvent(event: RunEventOut): RecursiveActivity | null {
  if (!isRecursiveEvent(event.event_type)) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const node = payload.node as Record<string, unknown> | undefined;
  const nodeName =
    node && typeof node.display_name === 'string' && node.display_name.trim()
      ? node.display_name.trim()
      : null;

  const detail =
    readString(payload, 'result_summary') ??
    readString(payload, 'task_summary') ??
    readString(payload, 'message') ??
    (readString(payload, 'tool_label') ? `Tool: ${readString(payload, 'tool_label')}` : null);

  let tone: StatusTone = 'neutral';
  if (event.event_type.endsWith('.failed')) tone = 'bad';
  else if (event.event_type.endsWith('.completed')) tone = 'good';
  else if (event.event_type.endsWith('.started') || event.event_type.endsWith('.leased')) {
    tone = 'active';
  } else if (event.event_type === 'run.waiting_external') tone = 'warn';

  return {
    id: event.id,
    at: event.created_at,
    label: EVENT_LABELS[event.event_type] ?? humanise(event.event_type),
    nodeName,
    detail,
    tone,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const delta = Math.round((now - then) / 1000);
  if (delta < 0) return 'just now';
  if (delta < 10) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/** The sentence that must accompany every recursive figure we show. */
export const CEILING_DISCLAIMER =
  'These are upper bounds, not predictions. A recursive participant chooses its own fan-out ' +
  'within these limits, so the actual work is usually well below the ceiling.';

export const BETA_DISCLAIMER =
  'Recursive execution is a beta feature. The turn runs on a machine you control, and the ' +
  'meeting record labels it as externally executed.';

/** Jobs that still have work ahead of them. */
export function jobIsActive(job: RecursiveAgentJobOut): boolean {
  return !['completed', 'failed', 'cancelled'].includes(job.status);
}
