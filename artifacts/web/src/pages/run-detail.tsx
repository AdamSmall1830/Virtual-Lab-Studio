import React, { useState } from 'react';
import { useRoute, Link } from 'wouter';
import {
  ArrowLeft, CheckCircle2, FileText, Database, ShieldCheck, Download, Code,
  FileTerminal, AlertTriangle, ChevronRight, ChevronDown, Loader2, XCircle,
  Clock, MessageSquare, Star, RefreshCw,
} from 'lucide-react';
import { format } from 'date-fns';
import {
  useRun,
  getRunQueryKey,
  useRunTurns,
  getRunTurnsQueryKey,
  useRunSummary,
  getRunSummaryQueryKey,
  useRunCitations,
  getListRunCitationsApiV1RunsRunIdCitationsGetQueryKey as getRunCitationsQueryKey,
  useRunManifest,
  getGetRunManifestApiV1RunsRunIdManifestGetQueryKey as getRunManifestQueryKey,
  useInterventions,
  getInterventionsQueryKey,
  useRunReviews,
  getRunReviewsQueryKey,
  useUpsertMyReview,
  useCreateExport,
  useRunExports,
  getRunExportsQueryKey,
  exportDownloadUrl,
  type RunOut,
  type RunSummaryOut,
  type RunReviewIn,
  RunReviewInStatus,
} from '@/api';
import { useQueryClient } from '@tanstack/react-query';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_stopped']);
const EXPORT_PENDING = new Set(['queued', 'running']);

function runTitle(run: RunOut): string {
  return `Run ${run.id.slice(0, 8)}`;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function StatusBadge({ status }: { status: string }) {
  const isDone = status === 'completed';
  const isFail = status === 'failed' || status === 'budget_stopped';
  const cls = isDone
    ? 'bg-accent/10 text-accent border-accent/20'
    : isFail
    ? 'bg-destructive/10 text-destructive border-destructive/20'
    : 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold uppercase tracking-wider border ${cls}`}>
      {isDone && <CheckCircle2 className="w-3.5 h-3.5" />}
      {isFail && <XCircle className="w-3.5 h-3.5" />}
      {!isDone && !isFail && <Clock className="w-3.5 h-3.5" />}
      {statusLabel(status)}
    </span>
  );
}

function Spinner({ label }: { label?: string }) {
  return (
    <div className="p-12 flex flex-col items-center justify-center text-muted-foreground gap-3">
      <Loader2 className="w-6 h-6 animate-spin" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="vls-glass rounded-xl p-10 text-center border border-destructive/30 bg-destructive/5">
      <XCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
      <p className="text-sm text-muted-foreground mb-4">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/90 transition-colors"
        >
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      )}
    </div>
  );
}

function EmptyState({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="p-12 text-center text-muted-foreground vls-glass rounded-xl border-dashed">
      <Icon className="w-10 h-10 mx-auto mb-3 opacity-30" />
      {children}
    </div>
  );
}

export default function RunDetail() {
  const [, params] = useRoute('/app/runs/:runId');
  const runId = params?.runId ?? '';
  const [tab, setTab] = useState('summary');

  const runQuery = useRun(runId, { query: { enabled: Boolean(runId), queryKey: getRunQueryKey(runId) } });
  const run = runQuery.data;

  if (!runId) return <div className="p-8 text-center text-muted-foreground">Run not found</div>;

  if (runQuery.isLoading) {
    return (
      <div className="max-w-5xl mx-auto pt-12">
        <Spinner label="Loading run…" />
      </div>
    );
  }

  if (runQuery.isError || !run) {
    return (
      <div className="max-w-5xl mx-auto pt-12">
        <ErrorState message="This run could not be loaded." onRetry={() => runQuery.refetch()} />
      </div>
    );
  }

  const tabs = [
    { id: 'summary', label: 'Conclusions' },
    { id: 'transcript', label: 'Transcript' },
    { id: 'evidence', label: 'Evidence & Citations' },
    { id: 'usage', label: 'Usage & Cost' },
    { id: 'manifest', label: 'Provenance Manifest' },
    { id: 'interventions', label: 'Interventions' },
    { id: 'review', label: 'Review' },
    { id: 'exports', label: 'Exports' },
  ];

  return (
    <div className="animate-in fade-in duration-300 max-w-5xl mx-auto h-full flex flex-col pb-12">
      <header className="mb-6">
        <Link href={`/app/projects/${run.project_id}/meetings`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Project
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <StatusBadge status={run.status} />
              {run.demo_mode && (
                <span className="bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded text-xs font-mono font-bold">
                  DEMO
                </span>
              )}
            </div>
            <h1 className="text-3xl font-display font-bold">{runTitle(run)}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Created {format(new Date(run.created_at), 'PPpp')}
              {run.completed_at && ` • Finished ${format(new Date(run.completed_at), 'pp')}`}
            </p>
          </div>
        </div>
      </header>

      {run.failure_safe_message && (
        <div className="mb-6 p-6 rounded-xl border-2 border-destructive/30 bg-destructive/5 flex items-start gap-4">
          <AlertTriangle className="w-8 h-8 text-destructive shrink-0" />
          <div>
            <h3 className="text-lg font-display font-bold text-destructive mb-1">Run {statusLabel(run.status)}</h3>
            <p className="text-foreground font-medium mb-1">{run.failure_safe_message}</p>
            {run.failure_code && (
              <p className="text-xs text-muted-foreground font-mono">Code: {run.failure_code}</p>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-border mb-6 overflow-x-auto pb-px">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1">
        {tab === 'summary' && <SummaryTab runId={runId} />}
        {tab === 'transcript' && <TranscriptTab runId={runId} />}
        {tab === 'evidence' && <CitationsTab runId={runId} />}
        {tab === 'usage' && <UsageTab run={run} />}
        {tab === 'manifest' && <ManifestTab runId={runId} />}
        {tab === 'interventions' && <InterventionsTab runId={runId} />}
        {tab === 'review' && <ReviewTab runId={runId} run={run} />}
        {tab === 'exports' && <ExportsTab runId={runId} run={run} />}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------

function SummaryTab({ runId }: { runId: string }) {
  const q = useRunSummary(runId, { query: { enabled: Boolean(runId), retry: false, queryKey: getRunSummaryQueryKey(runId) } });
  if (q.isLoading) return <Spinner label="Loading summary…" />;
  if (q.isError || !q.data) {
    return (
      <EmptyState icon={FileText}>
        Your team's conclusions will appear here once the meeting finishes.
      </EmptyState>
    );
  }
  const summary: RunSummaryOut = q.data;
  const sj = (summary.summary_json ?? {}) as Record<string, any>;
  const recommendation = sj.recommendation as Record<string, any> | undefined;
  const contributions = (sj.role_contributions ?? []) as Record<string, any>[];

  return (
    <div className="space-y-6">
      <div className="vls-reading-surface p-8 rounded-xl border border-border shadow-sm space-y-8">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-accent shrink-0" />
          <h2 className="text-xl font-display font-semibold">What your team concluded</h2>
        </div>
        {sj.executive_summary && (
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wider text-primary mb-3">Executive Summary</h3>
            <p className="text-lg leading-relaxed text-foreground font-serif whitespace-pre-wrap">{sj.executive_summary}</p>
          </section>
        )}

        {recommendation && (
          <>
            <div className="w-full h-px bg-border" />
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wider text-secondary mb-4">Recommendation & Decision</h3>
              <div className="bg-secondary/5 border border-secondary/20 p-5 rounded-lg space-y-3">
                {recommendation.decision && <div className="font-semibold text-lg">{recommendation.decision}</div>}
                {recommendation.rationale && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{recommendation.rationale}</p>}
                {Array.isArray(recommendation.conditions) && recommendation.conditions.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-secondary/10">
                    <div className="text-xs font-semibold mb-2">Required Conditions:</div>
                    <ul className="list-disc list-inside text-sm text-foreground space-y-1">
                      {recommendation.conditions.map((c: string, i: number) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {contributions.length > 0 && (
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">Role Contributions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {contributions.map((rc, i) => (
                <div key={i} className="border border-border rounded-lg p-4 bg-background">
                  <div className="font-semibold text-sm mb-2">{rc.agent_title ?? rc.role_type ?? `Contributor ${i + 1}`}</div>
                  <p className="text-sm text-muted-foreground mb-3 whitespace-pre-wrap">{rc.contribution}</p>
                  {Array.isArray(rc.evidence_ids) && rc.evidence_ids.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-auto">
                      {rc.evidence_ids.map((id: string) => (
                        <span key={id} className="text-[10px] font-mono bg-accent/10 text-accent px-1.5 py-0.5 rounded border border-accent/20">
                          {id}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <details className="vls-reading-surface rounded-xl border border-border overflow-hidden group">
        <summary className="p-4 flex items-center gap-2 cursor-pointer text-sm font-semibold bg-background/50 hover:bg-background/80">
          <FileText className="w-4 h-4" /> Full summary markdown
        </summary>
        <div className="p-6 border-t border-border font-serif text-[15px] leading-relaxed whitespace-pre-wrap">
          {summary.summary_markdown}
        </div>
      </details>
    </div>
  );
}

// -------------------------------------------------------------------------
// Transcript
// -------------------------------------------------------------------------

function TranscriptTab({ runId }: { runId: string }) {
  const q = useRunTurns(runId, { query: { enabled: Boolean(runId), queryKey: getRunTurnsQueryKey(runId) } });
  if (q.isLoading) return <Spinner label="Loading transcript…" />;
  if (q.isError) return <ErrorState message="Could not load the transcript." onRetry={() => q.refetch()} />;
  const turns = q.data ?? [];
  if (turns.length === 0) return <EmptyState icon={MessageSquare}>No transcript turns recorded for this run.</EmptyState>;

  return (
    <div className="vls-reading-surface rounded-xl border border-border p-6 space-y-6">
      {turns.map((turn) => {
        const tokens = (turn.input_tokens ?? 0) + (turn.output_tokens ?? 0);
        return (
          <div key={turn.id} className="flex flex-col gap-2 max-w-3xl">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display font-semibold text-sm capitalize">{turn.role_type}</span>
              <span className="text-xs text-muted-foreground font-mono bg-muted/50 px-1.5 py-0.5 rounded">
                R{turn.round_number}
              </span>
              <span className="text-xs text-muted-foreground font-mono">#{turn.sequence}</span>
              <span className="text-xs text-muted-foreground ml-auto font-mono">{tokens.toLocaleString()} tok</span>
            </div>
            <div className="p-4 rounded-xl text-[15px] leading-relaxed bg-background border border-border whitespace-pre-wrap">
              {turn.response_text ?? <span className="text-muted-foreground italic">No response text ({turn.status}).</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------------
// Evidence & Citations
// -------------------------------------------------------------------------

function CitationsTab({ runId }: { runId: string }) {
  const q = useRunCitations(runId, { query: { enabled: Boolean(runId), queryKey: getRunCitationsQueryKey(runId) } });
  if (q.isLoading) return <Spinner label="Loading citations…" />;
  if (q.isError) return <ErrorState message="Could not load citations." onRetry={() => q.refetch()} />;
  const citations = q.data ?? [];
  if (citations.length === 0) return <EmptyState icon={Database}>No evidence citations recorded for this run.</EmptyState>;

  return (
    <div className="space-y-4">
      {citations.map((c) => (
        <div key={c.id} className="vls-reading-surface p-4 rounded-xl border border-border flex items-start gap-4">
          <Database className="w-5 h-5 text-accent shrink-0 mt-1" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs bg-accent/10 text-accent px-1.5 py-0.5 rounded border border-accent/20">{c.citation_key}</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{c.support_type}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${c.validation_status === 'valid' ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground'}`}>
                {c.validation_status}
              </span>
            </div>
            <p className="text-sm text-foreground whitespace-pre-wrap">{c.claim_text}</p>
            {c.source_locator && <p className="text-xs text-muted-foreground mt-1 font-mono">{c.source_locator}</p>}
            {c.validation_notes && <p className="text-xs text-muted-foreground mt-2 italic">{c.validation_notes}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------
// Usage
// -------------------------------------------------------------------------

function UsageTab({ run }: { run: RunOut }) {
  const tokens = (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
  const cards = [
    { value: run.provider_call_count, label: 'Provider Calls' },
    { value: run.tool_call_count, label: 'Tool Calls' },
    { value: tokens.toLocaleString(), label: 'Total Tokens' },
    { value: `${run.wall_seconds}s`, label: 'Wall Time' },
    { value: run.current_round, label: 'Rounds' },
    { value: `$${Number(run.actual_cost_usd ?? 0).toFixed(2)}`, label: 'Cost USD', accent: true },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {cards.map((c) => (
        <div key={c.label} className="vls-glass p-6 rounded-xl text-center">
          <div className={`text-3xl font-mono font-bold mb-1 ${c.accent ? 'text-accent' : ''}`}>{c.value}</div>
          <div className="text-sm text-muted-foreground">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------
// Manifest
// -------------------------------------------------------------------------

function ManifestTab({ runId }: { runId: string }) {
  const q = useRunManifest(runId, { query: { enabled: Boolean(runId), retry: false, queryKey: getRunManifestQueryKey(runId) } });
  const [expanded, setExpanded] = useState(false);

  if (q.isLoading) return <Spinner label="Loading manifest…" />;
  if (q.isError || !q.data) {
    return <EmptyState icon={ShieldCheck}>A provenance manifest is not available for this run yet.</EmptyState>;
  }
  const m = q.data;

  return (
    <div className="space-y-6">
      <div className="bg-primary/10 border border-primary/20 p-4 rounded-xl flex items-start gap-4">
        <ShieldCheck className="w-6 h-6 text-primary shrink-0 mt-0.5" />
        <div>
          <h3 className="font-semibold text-sm text-primary mb-1">Reproducibility Manifest v{m.manifest_version}</h3>
          <p className="text-xs text-muted-foreground">
            Frozen agent snapshots, configuration, and SHA-256 content hashes to verifiably reproduce this meeting state.
          </p>
        </div>
      </div>

      <div className="vls-reading-surface p-5 rounded-xl border border-border">
        <h4 className="font-semibold text-sm mb-4 flex items-center gap-2">
          <FileTerminal className="w-4 h-4 text-accent" /> SHA-256 Hashes
        </h4>
        <div className="space-y-3 font-mono text-xs">
          {[
            ['Manifest payload', m.manifest_payload_sha256],
            ['Transcript', m.transcript_sha256],
            ['Summary', m.summary_sha256],
          ].map(([label, hash]) => (
            <div key={label}>
              <div className="text-muted-foreground mb-0.5">{label}</div>
              <div className="bg-background p-2 rounded border border-border/50 break-all">{hash || '—'}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="vls-reading-surface rounded-xl border border-border overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full p-4 flex items-center justify-between bg-background/50 hover:bg-background/80 transition-colors text-left"
        >
          <div className="font-semibold text-sm flex items-center gap-2">
            <Code className="w-4 h-4" /> Full manifest JSON
          </div>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        {expanded && (
          <pre className="bg-black text-green-400 font-mono text-xs p-4 overflow-auto border-t border-border max-h-[500px]">
            {JSON.stringify(m.manifest_json, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Interventions
// -------------------------------------------------------------------------

function InterventionsTab({ runId }: { runId: string }) {
  const q = useInterventions(runId, { query: { enabled: Boolean(runId), queryKey: getInterventionsQueryKey(runId) } });
  if (q.isLoading) return <Spinner label="Loading interventions…" />;
  if (q.isError) return <ErrorState message="Could not load interventions." onRetry={() => q.refetch()} />;
  const items = q.data ?? [];
  if (items.length === 0) return <EmptyState icon={MessageSquare}>No human interventions were recorded during this run.</EmptyState>;

  return (
    <div className="space-y-3">
      {items.map((i) => (
        <div key={i.id} className="vls-reading-surface p-4 rounded-xl border border-border">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">{i.kind.replace(/_/g, ' ')}</span>
            {i.applied_at_checkpoint && (
              <span className="text-xs text-muted-foreground font-mono">@ {i.applied_at_checkpoint}</span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">{format(new Date(i.created_at), 'PPp')}</span>
          </div>
          {i.content && <p className="text-sm text-foreground whitespace-pre-wrap">{i.content}</p>}
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------
// Review
// -------------------------------------------------------------------------

const REVIEW_STATUSES: { value: RunReviewIn['status']; label: string }[] = [
  { value: RunReviewInStatus.in_review, label: 'In review' },
  { value: RunReviewInStatus.approved, label: 'Approved' },
  { value: RunReviewInStatus.changes_requested, label: 'Changes requested' },
  { value: RunReviewInStatus.rejected, label: 'Rejected' },
];

const RUBRIC_CRITERIA = ['Evidence use', 'Rigor', 'Actionability', 'Clarity'];

function ReviewTab({ runId, run }: { runId: string; run: RunOut }) {
  const queryClient = useQueryClient();
  const reviewsQuery = useRunReviews(runId, { query: { enabled: Boolean(runId), queryKey: getRunReviewsQueryKey(runId) } });
  const upsert = useUpsertMyReview();

  const [status, setStatus] = useState<RunReviewIn['status']>(RunReviewInStatus.in_review);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [comments, setComments] = useState('');
  const [initialized, setInitialized] = useState(false);

  const isTerminal = TERMINAL.has(run.status);

  // Seed the form once from any existing reviews.
  const reviews = reviewsQuery.data ?? [];
  if (!initialized && reviews.length > 0) {
    const first = reviews[0];
    setStatus(first.status as RunReviewIn['status']);
    setRatings(
      Object.fromEntries(
        Object.entries(first.ratings ?? {}).map(([k, v]) => [k, Number(v) || 0]),
      ),
    );
    setComments(first.comments_markdown ?? '');
    setInitialized(true);
  }

  const submit = async () => {
    const cleanRatings = Object.fromEntries(
      Object.entries(ratings).filter(([, v]) => v >= 1 && v <= 5),
    );
    await upsert.mutateAsync({
      runId,
      data: {
        status,
        rubric_version: '1.0',
        ratings: cleanRatings,
        comments_markdown: comments,
      },
    });
    await queryClient.invalidateQueries();
  };

  if (!isTerminal) {
    return <EmptyState icon={Star}>Reviews can be recorded once the run finishes.</EmptyState>;
  }

  if (reviewsQuery.isLoading) return <Spinner label="Loading reviews…" />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="vls-reading-surface p-6 rounded-xl border border-border space-y-6">
        <h3 className="font-display font-semibold text-lg">Your Review</h3>

        <div className="space-y-2">
          <label className="text-sm font-medium">Decision</label>
          <div className="flex flex-wrap gap-2">
            {REVIEW_STATUSES.map((s) => (
              <button
                key={s.value}
                onClick={() => setStatus(s.value)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  status === s.value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border hover:border-primary/50'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-sm font-medium">Rubric ratings (1–5)</label>
          {RUBRIC_CRITERIA.map((c) => (
            <div key={c} className="flex items-center gap-3">
              <span className="text-sm w-32 shrink-0">{c}</span>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setRatings((prev) => ({ ...prev, [c]: prev[c] === n ? 0 : n }))}
                    className={`p-1 ${ratings[c] >= n ? 'text-primary' : 'text-muted-foreground/40'}`}
                    aria-label={`${c} ${n}`}
                  >
                    <Star className="w-5 h-5" fill={ratings[c] >= n ? 'currentColor' : 'none'} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Comments</label>
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Notes, requested changes, rationale…"
            className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[120px] focus:ring-2 focus:ring-primary/50 outline-none"
          />
        </div>

        {upsert.isError && (
          <p className="text-sm text-destructive">Could not save your review. Please try again.</p>
        )}

        <div className="flex justify-end">
          <button
            onClick={submit}
            disabled={upsert.isPending}
            className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50"
          >
            {upsert.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Save Review
          </button>
        </div>
      </div>

      {reviews.length > 0 && (
        <div>
          <h3 className="font-display font-semibold text-lg mb-3">All Reviews ({reviews.length})</h3>
          <div className="space-y-3">
            {reviews.map((r) => (
              <div key={r.id} className="vls-glass p-4 rounded-xl border border-border">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-primary">{statusLabel(r.status)}</span>
                  <span className="text-xs text-muted-foreground ml-auto">{format(new Date(r.updated_at), 'PPp')}</span>
                </div>
                {r.comments_markdown && (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{r.comments_markdown}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Exports
// -------------------------------------------------------------------------

function ExportsTab({ runId, run }: { runId: string; run: RunOut }) {
  const queryClient = useQueryClient();
  const isTerminal = TERMINAL.has(run.status);

  const exportsQuery = useRunExports(runId, {
    query: {
      enabled: Boolean(runId),
      queryKey: getRunExportsQueryKey(runId),
      refetchInterval: (query) => {
        const data = query.state.data as { status: string }[] | undefined;
        return data && data.some((j) => EXPORT_PENDING.has(j.status)) ? 2500 : false;
      },
    },
  });
  const createExport = useCreateExport();

  const jobs = exportsQuery.data ?? [];

  const requestExport = async () => {
    await createExport.mutateAsync({ runId });
    await queryClient.invalidateQueries({ queryKey: getRunExportsQueryKey(runId) });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="vls-glass p-8 rounded-xl text-center border-dashed border-2">
        <Download className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h2 className="text-xl font-display font-semibold mb-2">Reproducibility Export</h2>
        <p className="text-muted-foreground mb-6 text-sm">
          Generate a complete offline packet containing the frozen definition, transcript, summary,
          evidence, and provenance manifest with SHA-256 hashes.
        </p>
        {!isTerminal ? (
          <p className="text-sm text-warning">Export packets are available once the run finishes.</p>
        ) : (
          <button
            onClick={requestExport}
            disabled={createExport.isPending}
            className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors inline-flex items-center gap-2 disabled:opacity-50"
          >
            {createExport.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Request Export
          </button>
        )}
        {createExport.isError && (
          <p className="text-sm text-destructive mt-3">Could not start the export. Please try again.</p>
        )}
      </div>

      {exportsQuery.isLoading ? (
        <Spinner label="Loading exports…" />
      ) : exportsQuery.isError ? (
        <ErrorState message="Could not load export jobs." onRetry={() => exportsQuery.refetch()} />
      ) : jobs.length === 0 ? (
        <EmptyState icon={Download}>No export jobs yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const pending = EXPORT_PENDING.has(job.status);
            return (
              <div key={job.id} className="vls-reading-surface p-4 rounded-xl border border-border flex items-center gap-4">
                <div className="shrink-0">
                  {job.status === 'completed' ? (
                    <CheckCircle2 className="w-5 h-5 text-accent" />
                  ) : job.status === 'failed' || job.status === 'expired' ? (
                    <XCircle className="w-5 h-5 text-destructive" />
                  ) : (
                    <Loader2 className="w-5 h-5 text-primary animate-spin" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{job.format}</span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{statusLabel(job.status)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                    {format(new Date(job.created_at), 'PPp')}
                    {job.byte_size != null && ` • ${(job.byte_size / 1024).toFixed(1)} KB`}
                  </div>
                  {job.error_safe_message && (
                    <p className="text-xs text-destructive mt-1">{job.error_safe_message}</p>
                  )}
                </div>
                {job.status === 'completed' && (
                  <a
                    href={exportDownloadUrl(job.id)}
                    className="vls-glass text-foreground px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-background/50 flex items-center gap-2 border border-border shrink-0"
                  >
                    <Download className="w-4 h-4" /> Download
                  </a>
                )}
                {pending && <span className="text-xs text-muted-foreground shrink-0">Processing…</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
