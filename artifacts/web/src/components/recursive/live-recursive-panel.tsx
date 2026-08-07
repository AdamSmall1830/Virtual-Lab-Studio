import React from 'react';
import { Loader2, Network, RefreshCw } from 'lucide-react';
import {
  useRunRecursiveTree,
  getRunRecursiveTreeQueryKey,
  type RecursiveAgentJobDetailOut,
  type RunEventOut,
} from '@/api';
import {
  CEILING_DISCLAIMER,
  TONE_CLASS,
  describeRecursiveEvent,
  errorStatus,
  formatDuration,
  formatUsd,
  isRecursiveEvent,
  jobStatusPresentation,
  summariseNodes,
  type RecursiveActivity,
} from '@/lib/recursive';
import { StatusChip } from './status-chip';
import { RecursiveTree } from './recursive-tree';

/** How long to coalesce a burst of worker events into one tree refetch. */
const REFETCH_DEBOUNCE_MS = 1200;
const MAX_ACTIVITY_ROWS = 40;

function JobBlock({ detail, demoMode }: { detail: RecursiveAgentJobDetailOut; demoMode: boolean }) {
  const job = detail.job;
  const nodes = detail.nodes ?? [];
  const totals = summariseNodes(nodes);

  return (
    <div className="rounded-xl border border-border bg-background/30 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold truncate">{job.model_key}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            depth ≤ {job.max_depth} · ≤ {job.max_children} children · ≤ {job.max_agent_turns} turns ·
            ≤ {formatDuration(job.max_runtime_seconds)}
          </div>
        </div>
        <StatusChip presentation={jobStatusPresentation(job.status)} size="xs" className="shrink-0" />
      </div>

      {demoMode && (
        <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
          Simulated run — not a real recursive execution
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] font-mono">
        <div>
          <div className="text-muted-foreground font-sans">Agents</div>
          {totals.nodeCount}
        </div>
        <div>
          <div className="text-muted-foreground font-sans">Model calls</div>
          {job.model_call_count ?? 0}
        </div>
        <div>
          <div className="text-muted-foreground font-sans">Tokens</div>
          {((job.input_tokens ?? 0) + (job.output_tokens ?? 0)).toLocaleString()}
        </div>
        <div>
          <div className="text-muted-foreground font-sans">Cost</div>
          {formatUsd(job.cost_usd)}
          {job.max_cost_usd != null && (
            <span className="text-muted-foreground"> / ≤ {formatUsd(job.max_cost_usd)}</span>
          )}
        </div>
      </div>

      {job.failure_safe_message && (
        <p className="text-[11px] text-destructive" role="alert">
          {job.failure_safe_message}
        </p>
      )}

      <RecursiveTree nodes={nodes} />
    </div>
  );
}

function ActivityRow({ item }: { item: RecursiveActivity }) {
  return (
    <li className="flex items-start gap-2 text-[11px] leading-relaxed">
      <span
        className={`shrink-0 mt-0.5 rounded px-1 py-px font-semibold border ${TONE_CLASS[item.tone]}`}
      >
        {item.label}
      </span>
      <span className="min-w-0">
        {item.nodeName && <span className="font-semibold">{item.nodeName}</span>}
        {item.nodeName && item.detail ? ' — ' : ''}
        {item.detail && <span className="text-muted-foreground">{item.detail}</span>}
      </span>
    </li>
  );
}

/**
 * The recursive execution panel inside the live meeting room.
 *
 * The tree is always read from `GET /runs/{id}/recursive-tree` rather than
 * assembled from the event stream. Events only decide *when* to re-read: a
 * browser that reconnected mid-run cannot know what it missed, so trusting an
 * accumulated stream would let the panel drift from what the server actually
 * recorded — and this panel is the researcher's live view of the provenance
 * record. `reconnectNonce` forces that re-read on every reconnect.
 */
export function LiveRecursivePanel({
  runId,
  events,
  reconnectNonce,
  demoMode,
}: {
  runId: string;
  events: RunEventOut[];
  reconnectNonce: number;
  demoMode: boolean;
}) {
  const treeQuery = useRunRecursiveTree(runId, {
    query: {
      queryKey: getRunRecursiveTreeQueryKey(runId),
      enabled: Boolean(runId),
      retry: false,
      refetchInterval: 20_000,
    },
  });

  const refetch = treeQuery.refetch;
  const lastRefetchedSeq = React.useRef(0);

  // Coalesce a burst of worker events into a single authoritative re-read.
  const latestRecursiveSeq = React.useMemo(() => {
    let seq = 0;
    for (const ev of events) {
      if (isRecursiveEvent(ev.event_type)) seq = Math.max(seq, ev.run_sequence);
    }
    return seq;
  }, [events]);

  React.useEffect(() => {
    if (latestRecursiveSeq <= lastRefetchedSeq.current) return;
    const timer = setTimeout(() => {
      lastRefetchedSeq.current = latestRecursiveSeq;
      void refetch();
    }, REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [latestRecursiveSeq, refetch]);

  // A reconnect invalidates our assumption that the stream was complete.
  React.useEffect(() => {
    if (reconnectNonce === 0) return;
    lastRefetchedSeq.current = 0;
    void refetch();
  }, [reconnectNonce, refetch]);

  const activity = React.useMemo(() => {
    const rows: RecursiveActivity[] = [];
    for (let i = events.length - 1; i >= 0 && rows.length < MAX_ACTIVITY_ROWS; i -= 1) {
      const described = describeRecursiveEvent(events[i]);
      if (described) rows.push(described);
    }
    return rows;
  }, [events]);

  // A 404 means this deployment does not run the recursive runtime at all.
  if (errorStatus(treeQuery.error) === 404) return null;

  const jobs = treeQuery.data?.jobs ?? [];
  // Nothing recursive in this run and nothing reported: stay out of the way.
  if (!treeQuery.isLoading && jobs.length === 0 && activity.length === 0) return null;

  return (
    <section
      aria-labelledby="live-recursive-heading"
      className="vls-glass rounded-xl border p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="live-recursive-heading"
            className="text-sm font-display font-bold flex items-center gap-2"
          >
            <Network className="w-4 h-4 text-primary" aria-hidden />
            Recursive execution
          </h3>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
            {CEILING_DISCLAIMER}
          </p>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={treeQuery.isFetching}
          className="shrink-0 text-[11px] font-semibold text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors disabled:opacity-50"
        >
          {treeQuery.isFetching ? (
            <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="w-3 h-3" aria-hidden />
          )}
          Refresh
        </button>
      </div>

      {treeQuery.isError && errorStatus(treeQuery.error) !== 404 && (
        <p className="text-[11px] text-destructive" role="alert">
          The recursive tree could not be loaded. The figures below may be out of date.
        </p>
      )}

      {jobs.map((detail) => (
        <JobBlock key={detail.job.id} detail={detail} demoMode={demoMode} />
      ))}

      {activity.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1.5">
            Worker activity
          </div>
          <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
            {activity.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
