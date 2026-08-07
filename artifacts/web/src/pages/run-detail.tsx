import React, { useState } from 'react';
import { useRoute, useLocation, Link } from 'wouter';
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
  useRetryRun,
  useCreateExport,
  useRunExports,
  getRunExportsQueryKey,
  exportDownloadUrl,
  ExportCreateInFormat,
  type RunOut,
  type RunSummaryOut,
  type RunReviewIn,
  RunReviewInStatus,
} from '@/api';
import { useQueryClient } from '@tanstack/react-query';
import { DemoBadge } from '@/components/demo-badge';
import { PdfReportButton } from '@/components/pdf-report-button';
import { describeSections } from '@/lib/report-sections';
import { formatRunCost, isUnpricedRun, UNPRICED_COST_HINT } from '@/lib/cost';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_stopped']);
// Stopped before finishing: the transcript so far is intact, so the run can be
// picked up again from its last completed turn instead of paying for it twice.
// budget_stopped is excluded — its spend still counts against the frozen
// budget, so it would stop again at the very next checkpoint.
const RESUMABLE = new Set(['failed', 'cancelled']);
const EXPORT_PENDING = new Set(['queued', 'running']);
const EXPORT_FORMAT_LABEL: Record<string, string> = {
  repro_zip: 'Reproducibility packet (ZIP)',
  report_pdf: 'Readable report (PDF)',
};

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
  const retryRun = useRetryRun();
  const detailQueryClient = useQueryClient();
  const [, navigate] = useLocation();

  const handleResume = async () => {
    await retryRun.mutateAsync({ runId });
    await detailQueryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) });
    navigate(`/app/runs/${runId}/live`);
  };

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
              {run.demo_mode && <DemoBadge />}
            </div>
            <h1 className="text-3xl font-display font-bold">{runTitle(run)}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Created {format(new Date(run.created_at), 'PPpp')}
              {run.completed_at && ` • Finished ${format(new Date(run.completed_at), 'pp')}`}
            </p>
          </div>
        </div>
      </header>

      {(run.failure_safe_message || RESUMABLE.has(run.status)) && (
        <div
          className={`mb-6 p-6 rounded-xl border-2 flex items-start gap-4 ${
            run.failure_safe_message
              ? 'border-destructive/30 bg-destructive/5'
              : 'border-border bg-muted/30'
          }`}
        >
          <AlertTriangle
            className={`w-8 h-8 shrink-0 ${
              run.failure_safe_message ? 'text-destructive' : 'text-muted-foreground'
            }`}
          />
          <div className="flex-1 min-w-0">
            <h3
              className={`text-lg font-display font-bold mb-1 ${
                run.failure_safe_message ? 'text-destructive' : 'text-foreground'
              }`}
            >
              Run {statusLabel(run.status)}
            </h3>
            {run.failure_safe_message && (
              <p className="text-foreground font-medium mb-1">{run.failure_safe_message}</p>
            )}
            {run.failure_code && (
              <p className="text-xs text-muted-foreground font-mono">Code: {run.failure_code}</p>
            )}

            {RESUMABLE.has(run.status) && (
              <div className="mt-4">
                <button
                  onClick={handleResume}
                  disabled={retryRun.isPending}
                  data-testid="button-resume-run"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 disabled:opacity-60 transition-opacity"
                >
                  {retryRun.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  Resume from turn {run.provider_call_count + 1}
                </button>
                <p className="text-xs text-muted-foreground mt-2 max-w-prose" data-testid="text-resume-explainer">
                  {run.provider_call_count > 0 ? (
                    <>
                      The {run.provider_call_count} turn{run.provider_call_count === 1 ? '' : 's'} already
                      completed are replayed from this run&rsquo;s saved transcript — your provider is only
                      charged for the turns that are still missing.
                    </>
                  ) : (
                    <>This run stopped before any turn completed, so it starts again from the beginning.</>
                  )}
                </p>
                {retryRun.isError && (
                  <p className="text-xs text-destructive mt-2" data-testid="text-resume-error">
                    Could not resume this run. Please try again.
                  </p>
                )}
              </div>
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

function formatValidationError(err: unknown): string {
  if (err == null) return 'Unknown validation error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as Record<string, any>;
    // Common JSON-schema error shapes: { loc/path, msg/message }.
    const loc = e.loc ?? e.path ?? e.instancePath;
    const msg = e.msg ?? e.message ?? e.error;
    const locStr = Array.isArray(loc) ? loc.join('.') : loc != null ? String(loc) : '';
    if (msg && locStr) return `${locStr}: ${msg}`;
    if (msg) return String(msg);
    if (locStr) return locStr;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// Shown whenever the structured summary failed schema validation. The summary
// is still rendered (so reviewers can inspect it) but this banner makes clear
// it must not be relied on or cited.
export function SummaryValidationBanner({ summary }: { summary: RunSummaryOut }) {
  if (summary.validation_status === 'valid') return null;

  const errors = Array.isArray(summary.validation_errors) ? summary.validation_errors : [];
  const shown = errors.slice(0, 5);
  const remaining = errors.length - shown.length;

  return (
    <div
      data-testid="banner-summary-invalid"
      className="p-6 rounded-xl border-2 border-destructive/30 bg-destructive/5 flex items-start gap-4"
    >
      <AlertTriangle className="w-8 h-8 shrink-0 text-destructive" />
      <div className="flex-1 min-w-0">
        <h3 className="text-lg font-display font-bold mb-1 text-destructive">
          Structured summary failed schema validation
        </h3>
        <p className="text-sm text-foreground font-medium mb-3">
          This summary did not conform to the expected schema. It must not be relied on or cited as
          an authoritative result.
        </p>
        {shown.length > 0 && (
          <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 font-mono">
            {shown.map((err, i) => (
              <li key={i} className="break-words">{formatValidationError(err)}</li>
            ))}
            {remaining > 0 && (
              <li className="list-none text-xs italic">+{remaining} more validation error{remaining === 1 ? '' : 's'}</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  high: 'bg-destructive/10 text-destructive border-destructive/25',
  medium: 'bg-secondary/10 text-secondary border-secondary/25',
  low: 'bg-muted text-muted-foreground border-border',
  now: 'bg-destructive/10 text-destructive border-destructive/25',
  next: 'bg-secondary/10 text-secondary border-secondary/25',
  later: 'bg-muted text-muted-foreground border-border',
  resolved: 'bg-accent/10 text-accent border-accent/25',
  unresolved: 'bg-destructive/10 text-destructive border-destructive/25',
  needs_evidence: 'bg-secondary/10 text-secondary border-secondary/25',
};

function Chip({ children }: { children: React.ReactNode }) {
  const key = String(children ?? '').toLowerCase().replace(/ /g, '_');
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap ${
        TONE[key] ?? 'bg-muted text-muted-foreground border-border'
      }`}
    >
      {String(children).replace(/_/g, ' ')}
    </span>
  );
}

function SummarySection({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="w-full h-px bg-border" />
      <section data-testid={testId}>
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">{title}</h3>
        {children}
      </section>
    </>
  );
}

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
  const questionAnswers = (sj.question_answers ?? []) as Record<string, any>[];
  const disagreements = (sj.disagreements ?? []) as Record<string, any>[];
  const assumptions = (sj.assumptions ?? []) as Record<string, any>[];
  const risks = (sj.risks_and_limitations ?? []) as Record<string, any>[];
  const nextSteps = (sj.next_steps ?? []) as Record<string, any>[];
  const confidence = sj.confidence as Record<string, any> | undefined;
  const disclosure = sj.disclosure as Record<string, any> | undefined;
  const limitations = (disclosure?.limitations ?? []) as string[];
  const overall = typeof confidence?.overall === 'number' ? (confidence.overall as number) : null;

  return (
    <div className="space-y-6">
      <SummaryValidationBanner summary={summary} />

      <div className="vls-reading-surface p-8 rounded-xl border border-border shadow-sm space-y-8">
        <div className="flex items-center gap-3 flex-wrap">
          <CheckCircle2 className="w-5 h-5 text-accent shrink-0" />
          <h2 className="text-xl font-display font-semibold">What your team concluded</h2>
          <div className="ml-auto flex items-center gap-3">
            {overall !== null && (
              <span
                data-testid="text-confidence-overall"
                title="Confidence stated by the model that held the meeting. It is not a validated measure of correctness."
                className="text-xs font-mono px-2 py-1 rounded border border-border bg-background text-muted-foreground"
              >
                stated confidence {overall.toFixed(2)}
              </span>
            )}
            <PdfReportButton runId={runId} />
          </div>
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

        <SummarySection title="Agenda Questions" testId="section-question-answers">
          {questionAnswers.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-questions">
              No agenda questions were set for this meeting, so there are no per-question findings.
              Add questions when you set up a session and the team will answer each one directly.
            </p>
          ) : (
            <div className="space-y-4">
              {questionAnswers.map((qa, i) => (
                <div key={i} className="border border-border rounded-lg p-4 bg-background">
                  <div className="font-semibold text-sm mb-2">{qa.question}</div>
                  <p className="text-sm text-foreground whitespace-pre-wrap mb-3">{qa.answer}</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    {typeof qa.confidence === 'number' && (
                      <span className="text-[10px] font-mono text-muted-foreground">
                        stated confidence {qa.confidence.toFixed(2)}
                      </span>
                    )}
                    {Array.isArray(qa.evidence_ids) && qa.evidence_ids.map((id: string) => (
                      <span key={id} className="text-[10px] font-mono bg-accent/10 text-accent px-1.5 py-0.5 rounded border border-accent/20">
                        {id}
                      </span>
                    ))}
                  </div>
                  {qa.open_issue && (
                    <p className="text-xs text-muted-foreground italic mt-2">Open issue: {qa.open_issue}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </SummarySection>

        {disagreements.length > 0 && (
          <SummarySection title="Where the Team Disagreed" testId="section-disagreements">
            <div className="space-y-4">
              {disagreements.map((d, i) => (
                <div key={i} className="border border-border rounded-lg p-4 bg-background">
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="font-semibold text-sm">{d.topic}</span>
                    {d.resolution_status && <Chip>{d.resolution_status}</Chip>}
                  </div>
                  <div className="space-y-2">
                    {(d.positions ?? []).map((p: Record<string, any>, k: number) => (
                      <div key={k} className="text-sm border-l-2 border-border pl-3">
                        <span className="font-medium">{p.agent_title}</span>
                        <span className="text-muted-foreground"> — {p.position}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SummarySection>
        )}

        {risks.length > 0 && (
          <SummarySection title="Risks & Limitations" testId="section-risks">
            <div className="space-y-3">
              {risks.map((r, i) => (
                <div key={i} className="border border-border rounded-lg p-4 bg-background">
                  <div className="flex items-start gap-2 mb-2 flex-wrap">
                    <span className="text-sm font-medium flex-1 min-w-0">{r.risk}</span>
                    {r.severity && <Chip>{r.severity}</Chip>}
                    {r.likelihood && <Chip>{r.likelihood}</Chip>}
                  </div>
                  {r.mitigation && (
                    <p className="text-sm text-muted-foreground">
                      <span className="font-semibold text-foreground">Mitigation. </span>{r.mitigation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </SummarySection>
        )}

        {assumptions.length > 0 && (
          <SummarySection title="Assumptions" testId="section-assumptions">
            <div className="space-y-3">
              {assumptions.map((a, i) => (
                <div key={i} className="border border-border rounded-lg p-4 bg-background">
                  <div className="flex items-start gap-2 mb-2 flex-wrap">
                    <span className="text-sm font-medium flex-1 min-w-0">{a.assumption}</span>
                    {a.impact && <Chip>{a.impact}</Chip>}
                  </div>
                  {a.validation && (
                    <p className="text-sm text-muted-foreground">
                      <span className="font-semibold text-foreground">How to validate. </span>{a.validation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </SummarySection>
        )}

        {nextSteps.length > 0 && (
          <SummarySection title="Next Steps" testId="section-next-steps">
            <ol className="space-y-3">
              {nextSteps.map((n, i) => (
                <li key={i} className="border border-border rounded-lg p-4 bg-background flex gap-3">
                  <span className="text-xs font-mono text-muted-foreground pt-0.5">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-medium flex-1 min-w-0">{n.action}</span>
                      {n.priority && <Chip>{n.priority}</Chip>}
                    </div>
                    {n.owner_role && (
                      <div className="text-xs text-muted-foreground mb-1">Owner: {n.owner_role}</div>
                    )}
                    {n.acceptance_criterion && (
                      <p className="text-sm text-muted-foreground">
                        <span className="font-semibold text-foreground">Done when. </span>{n.acceptance_criterion}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </SummarySection>
        )}

        {contributions.length > 0 && (
          <SummarySection title="Role Contributions" testId="section-role-contributions">
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
          </SummarySection>
        )}

        {(confidence?.basis || confidence?.uncertainty) && (
          <SummarySection title="Confidence & Uncertainty" testId="section-confidence">
            <div className="space-y-3 text-sm">
              {overall !== null && (
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">{overall.toFixed(2)} </span>
                  as stated by the model that held the meeting. This is the model&rsquo;s own
                  assessment, not a validated measure of correctness.
                </p>
              )}
              {confidence?.basis && (
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">Basis. </span>{confidence.basis}
                </p>
              )}
              {confidence?.uncertainty && (
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">Remaining uncertainty. </span>{confidence.uncertainty}
                </p>
              )}
            </div>
          </SummarySection>
        )}

        {limitations.length > 0 && (
          <SummarySection title="Disclosure" testId="section-disclosure">
            <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
              {limitations.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
            {disclosure?.human_review_required && (
              <p className="text-sm font-medium text-foreground mt-3">
                Human expert review is required before this result is relied on.
              </p>
            )}
          </SummarySection>
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
  if (citations.length === 0)
    return (
      <EmptyState icon={Database}>
        No evidence citations were recorded for this run. Citations appear only when evidence
        sources are attached to a meeting before it is launched and the team cites them.
      </EmptyState>
    );

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
  const unpriced = isUnpricedRun(run);
  const cards = [
    { value: run.provider_call_count, label: 'Provider Calls' },
    { value: run.tool_call_count, label: 'Tool Calls' },
    { value: tokens.toLocaleString(), label: 'Total Tokens' },
    { value: `${run.wall_seconds}s`, label: 'Wall Time' },
    { value: run.current_round, label: 'Rounds' },
    {
      value: formatRunCost(run),
      label: 'Cost USD',
      accent: true,
      hint: unpriced ? UNPRICED_COST_HINT : undefined,
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {cards.map((c) => (
        <div key={c.label} className="vls-glass p-6 rounded-xl text-center" title={c.hint}>
          <div className={`text-3xl font-mono font-bold mb-1 ${c.accent ? 'text-accent' : ''}`}>{c.value}</div>
          <div className="text-sm text-muted-foreground">{c.label}</div>
          {c.hint && (
            <div className="text-xs text-muted-foreground mt-2 max-w-[16rem] mx-auto" data-testid="hint-cost-unpriced">
              {c.hint}
            </div>
          )}
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
    await createExport.mutateAsync({ runId, data: { format: ExportCreateInFormat.repro_zip } });
    await queryClient.invalidateQueries({ queryKey: getRunExportsQueryKey(runId) });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="vls-glass p-6 rounded-xl border-dashed border-2 flex flex-col">
          <Download className="w-8 h-8 text-muted-foreground mb-3 opacity-50" />
          <h2 className="text-base font-display font-semibold mb-2">Reproducibility packet</h2>
          <p className="text-muted-foreground mb-5 text-sm flex-1">
            A complete offline ZIP containing the frozen definition, transcript, summary, evidence,
            and provenance manifest with SHA-256 hashes. For archiving and independent checking.
          </p>
          {!isTerminal ? (
            <p className="text-sm text-warning">Available once the run finishes.</p>
          ) : (
            <button
              onClick={requestExport}
              disabled={createExport.isPending}
              data-testid="button-request-packet"
              className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors inline-flex items-center gap-2 disabled:opacity-50 self-start"
            >
              {createExport.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Build packet
            </button>
          )}
          {createExport.isError && (
            <p className="text-sm text-destructive mt-3">Could not start the export. Please try again.</p>
          )}
        </div>

        <div className="vls-glass p-6 rounded-xl border-dashed border-2 flex flex-col">
          <FileText className="w-8 h-8 text-muted-foreground mb-3 opacity-50" />
          <h2 className="text-base font-display font-semibold mb-2">Readable report</h2>
          <p className="text-muted-foreground mb-5 text-sm flex-1">
            A typeset PDF of the conclusions, with whichever appendices you choose. For circulating
            and reading — every page is marked model-generated.
          </p>
          {!isTerminal ? (
            <p className="text-sm text-warning">Available once the run finishes.</p>
          ) : (
            <PdfReportButton runId={runId} prominent className="self-start" />
          )}
        </div>
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
                    <span className="font-medium text-sm">{EXPORT_FORMAT_LABEL[job.format] ?? job.format}</span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{statusLabel(job.status)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                    {format(new Date(job.created_at), 'PPp')}
                    {job.byte_size != null && ` • ${(job.byte_size / 1024).toFixed(1)} KB`}
                  </div>
                  {job.format === 'report_pdf' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {describeSections(job.options?.sections) ?? 'Conclusions only'}
                    </p>
                  )}
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
