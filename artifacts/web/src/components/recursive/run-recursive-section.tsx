import React from 'react';
import { Info, Loader2, Network } from 'lucide-react';
import {
  getRunRecursiveTreeQueryKey,
  useRunRecursiveTree,
  type RecursiveAgentJobDetailOut,
} from '@/api';
import {
  CEILING_DISCLAIMER,
  errorStatus,
  formatDuration,
  formatUsd,
  jobStatusPresentation,
  summariseNodes,
} from '@/lib/recursive';
import { StatusChip } from './status-chip';
import { RecursiveTree } from './recursive-tree';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
        {label}
      </div>
      <div className="font-mono text-sm font-semibold mt-1">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function JobPanel({ detail, demoMode }: { detail: RecursiveAgentJobDetailOut; demoMode: boolean }) {
  const job = detail.job;
  const nodes = detail.nodes ?? [];
  const totals = summariseNodes(nodes);
  const tokens = (job.input_tokens ?? 0) + (job.output_tokens ?? 0);

  return (
    <div className="vls-reading-surface rounded-xl border p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-base">Recursive turn</h3>
            <StatusChip presentation={jobStatusPresentation(job.status)} />
          </div>
          <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
            coordinator {job.model_key}
            {job.child_model_key ? ` · children ${job.child_model_key}` : ''}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground text-right">
          <div>
            {job.started_at ? new Date(job.started_at).toLocaleString() : 'Not started'}
          </div>
          {job.completed_at && <div>finished {new Date(job.completed_at).toLocaleString()}</div>}
        </div>
      </div>

      {demoMode && (
        <p className="text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2">
          Simulated run — this record was produced by the demo provider, not by a real recursive
          worker.
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Agents" value={String(totals.nodeCount)} sub={`depth reached ${totals.maxDepthSeen}`} />
        <Stat label="Model calls" value={String(job.model_call_count ?? 0)} />
        <Stat label="Tokens" value={tokens.toLocaleString()} />
        <Stat
          label="Cost"
          value={formatUsd(job.cost_usd)}
          sub={job.max_cost_usd != null ? `ceiling ${formatUsd(job.max_cost_usd)}` : 'no ceiling set'}
        />
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-2">
          Limits this turn ran under
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground">
          <span>≤ {job.max_children} children</span>
          <span>≤ depth {job.max_depth}</span>
          <span>≤ {job.max_agent_turns} agent turns</span>
          <span>≤ {job.max_tokens.toLocaleString()} tokens</span>
          <span>≤ {formatDuration(job.max_runtime_seconds)}</span>
          <span>profile {job.capability_profile}</span>
        </div>
      </div>

      {job.failure_safe_message && (
        <p className="text-sm text-destructive rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2" role="alert">
          {job.failure_code ? `${job.failure_code}: ` : ''}
          {job.failure_safe_message}
        </p>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-2">
          Agent tree ({totals.completed} completed, {totals.failed} failed, {totals.running} running)
        </div>
        <RecursiveTree
          nodes={nodes}
          emptyMessage="The worker reported no individual agents for this turn."
        />
      </div>
    </div>
  );
}

/**
 * The permanent record of recursive execution for a finished run.
 *
 * This reads the same server-side node records the export and manifest are
 * built from, so what a researcher sees here is what the provenance record
 * contains — no client-side reconstruction sits between them.
 */
export function RunRecursiveSection({
  runId,
  demoMode,
}: {
  runId: string;
  demoMode: boolean;
}) {
  const treeQuery = useRunRecursiveTree(runId, {
    query: {
      queryKey: getRunRecursiveTreeQueryKey(runId),
      enabled: Boolean(runId),
      retry: false,
    },
  });

  if (treeQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        Loading recursive execution…
      </div>
    );
  }

  if (errorStatus(treeQuery.error) === 404) {
    return (
      <div className="p-8 text-center text-muted-foreground vls-glass rounded-xl border-dashed">
        <Network className="w-10 h-10 mx-auto mb-3 opacity-30" aria-hidden />
        <p className="text-sm">
          This deployment does not run the recursive agent runtime, so no run can have recursive
          turns.
        </p>
      </div>
    );
  }

  if (treeQuery.isError) {
    return (
      <div className="p-6 rounded-xl border border-destructive/40 bg-destructive/5 text-sm" role="alert">
        <div className="font-semibold text-destructive">Could not load recursive execution</div>
        <button
          onClick={() => void treeQuery.refetch()}
          className="mt-2 text-xs font-semibold underline hover:no-underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const jobs = treeQuery.data?.jobs ?? [];
  if (jobs.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground vls-glass rounded-xl border-dashed">
        <Network className="w-10 h-10 mx-auto mb-3 opacity-30" aria-hidden />
        <p className="text-sm">
          No participant in this run used recursive execution. Every turn ran as a standard agent.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Recursive turns were executed by a worker on a machine the researcher controls. The limits
          shown are the ceilings the turn ran under. {CEILING_DISCLAIMER}
        </p>
      </div>
      {jobs.map((detail) => (
        <JobPanel key={detail.job.id} detail={detail} demoMode={demoMode} />
      ))}
    </div>
  );
}
