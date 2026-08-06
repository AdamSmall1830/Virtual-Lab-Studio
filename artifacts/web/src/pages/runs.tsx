import React from 'react';
import { Link } from 'wouter';
import { useQueries } from '@tanstack/react-query';
import {
  Activity, Play, CheckCircle2, XCircle, Clock, AlertTriangle, ChevronRight, Loader2,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { useSession } from '@/api/session';
import {
  useProjects,
  getProjectsQueryKey,
  getProjectRunsQueryKey,
  listRunsApiV1ProjectsProjectIdRunsGet,
  type RunOut,
  type ProjectOut,
} from '@/api';
import { formatRunCost, isUnpricedRun, UNPRICED_COST_HINT } from '@/lib/cost';

type FlatRun = RunOut & { projectName: string };

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_stopped']);
const LIVE = new Set(['queued', 'leased', 'running', 'pausing', 'paused', 'cancelling']);

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-5 h-5 text-accent" />;
    case 'running':
    case 'leased':
      return <Activity className="w-5 h-5 text-primary animate-pulse" />;
    case 'failed':
    case 'budget_stopped':
      return <XCircle className="w-5 h-5 text-destructive" />;
    case 'paused':
    case 'pausing':
    case 'cancelling':
      return <AlertTriangle className="w-5 h-5 text-warning" />;
    case 'cancelled':
      return <XCircle className="w-5 h-5 text-muted-foreground" />;
    default:
      return <Clock className="w-5 h-5 text-muted-foreground" />;
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function runTitle(run: RunOut): string {
  return `Run ${run.id.slice(0, 8)}`;
}

export default function Runs() {
  const { workspaceId } = useSession();

  const projectsQuery = useProjects(workspaceId ?? '', {
    query: {
      queryKey: getProjectsQueryKey(workspaceId ?? ''),
      enabled: Boolean(workspaceId),
    },
  });
  const projects: ProjectOut[] = projectsQuery.data ?? [];

  const runQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: getProjectRunsQueryKey(p.id),
      queryFn: () => listRunsApiV1ProjectsProjectIdRunsGet(p.id),
      enabled: Boolean(workspaceId),
    })),
  });

  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  const runsLoading = runQueries.some((q) => q.isLoading);
  const runsError = runQueries.some((q) => q.isError);

  const runs: FlatRun[] = runQueries
    .flatMap((q) => (q.data ?? []) as RunOut[])
    .map((r) => ({ ...r, projectName: projectName.get(r.project_id) ?? 'Unknown project' }))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const isLoading = (projectsQuery.isLoading || runsLoading) && !projectsQuery.isError;

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-12">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Meetings &amp; Results</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every multi-agent meeting across your projects — conclusions, transcripts, and audit trail.
          </p>
        </div>
        <Link
          href="/app/meetings/new"
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2"
        >
          <Play className="w-4 h-4" /> New Meeting
        </Link>
      </header>

      {isLoading ? (
        <div className="vls-reading-surface rounded-xl overflow-hidden divide-y divide-border border border-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 p-5 animate-pulse">
              <div className="w-5 h-5 rounded-full bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-24 bg-muted rounded" />
                <div className="h-4 w-48 bg-muted rounded" />
              </div>
              <div className="w-24 h-4 bg-muted rounded" />
            </div>
          ))}
        </div>
      ) : projectsQuery.isError ? (
        <div className="vls-glass rounded-xl p-12 text-center border border-destructive/30 bg-destructive/5">
          <XCircle className="w-10 h-10 text-destructive mx-auto mb-4" />
          <h2 className="text-lg font-semibold mb-2">Could not load runs</h2>
          <p className="text-sm text-muted-foreground mb-4">
            We couldn&apos;t reach your workspace projects. Check your connection and try again.
          </p>
          <button
            onClick={() => projectsQuery.refetch()}
            className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/90 transition-colors"
          >
            <Loader2 className="w-4 h-4" /> Retry
          </button>
        </div>
      ) : runs.length === 0 ? (
        <div className="vls-glass rounded-xl p-16 text-center border-dashed">
          <Activity className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h2 className="text-xl font-display font-semibold mb-2">No runs executed</h2>
          <p className="text-muted-foreground max-w-sm mx-auto mb-6">
            Start a meeting from a template or scratch to see live execution and structural
            summaries here.
          </p>
          {runsError && (
            <p className="text-xs text-warning mb-4">
              Some projects failed to load their runs; the list may be incomplete.
            </p>
          )}
          <Link
            href="/app/meetings/new"
            className="bg-foreground text-background px-6 py-2.5 rounded-lg text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/90 transition-colors"
          >
            <Play className="w-4 h-4" /> Configure a Meeting
          </Link>
        </div>
      ) : (
        <>
          {runsError && (
            <div className="text-xs text-warning bg-warning/5 border border-warning/20 rounded-lg px-3 py-2">
              Some projects failed to load their runs; the list may be incomplete.
            </div>
          )}
          <div className="vls-reading-surface rounded-xl overflow-hidden divide-y divide-border border border-border">
            {runs.map((run) => {
              const isLive = LIVE.has(run.status) && !TERMINAL.has(run.status);
              const tokens = (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
              return (
                <div
                  key={run.id}
                  className="group relative flex flex-col md:flex-row md:items-center gap-4 p-5 hover:bg-background/50 transition-colors"
                >
                  <Link
                    href={isLive ? `/app/runs/${run.id}/live` : `/app/runs/${run.id}`}
                    className="absolute inset-0 z-0"
                  />

                  <div className="relative z-10 shrink-0 mt-1 md:mt-0">
                    <StatusIcon status={run.status} />
                  </div>

                  <div className="relative z-10 flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-background border border-border uppercase tracking-wider text-muted-foreground">
                        {statusLabel(run.status)}
                      </span>
                      {run.demo_mode && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-primary/10 text-primary uppercase tracking-wider">
                          Demo
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground truncate max-w-[220px] hidden sm:inline-block">
                        in {run.projectName}
                      </span>
                    </div>
                    <h3 className="text-lg font-display font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                      {runTitle(run)}
                    </h3>
                    <div className="text-sm text-muted-foreground mt-1 flex flex-wrap items-center gap-3">
                      <span className="flex items-center gap-1 font-mono text-xs">
                        {format(new Date(run.created_at), 'MMM d, HH:mm')}
                      </span>
                      <span>•</span>
                      <span>Round {run.current_round}</span>
                      <span>•</span>
                      <span>{tokens.toLocaleString()} tokens</span>
                      <span>•</span>
                      {isUnpricedRun(run) ? (
                        <span
                          className="relative z-10 cursor-help"
                          title={UNPRICED_COST_HINT}
                          data-testid="text-cost-unpriced"
                        >
                          {formatRunCost(run)}
                        </span>
                      ) : (
                        <span>{formatRunCost(run)}</span>
                      )}
                    </div>
                  </div>

                  <div className="relative z-10 shrink-0 flex items-center justify-end gap-4 md:w-48 text-right">
                    {isLive ? (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary" /> Live
                      </span>
                    ) : (
                      <div className="text-xs text-muted-foreground font-mono">
                        {formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}
                      </div>
                    )}
                    <ChevronRight className="w-5 h-5 text-muted-foreground opacity-50 group-hover:opacity-100 group-hover:text-primary transition-all group-hover:translate-x-1" />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
