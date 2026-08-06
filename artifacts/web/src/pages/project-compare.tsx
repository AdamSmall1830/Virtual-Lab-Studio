import React, { useState } from 'react';
import { useRoute } from 'wouter';
import {
  GitMerge, Plus, EyeOff, Eye, Save, Check, Loader2, XCircle, X, Star, ArrowLeft,
} from 'lucide-react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import {
  useProjectRuns,
  getProjectRunsQueryKey,
  useProjectComparisons,
  getProjectComparisonsQueryKey,
  useCreateComparison,
  useComparison,
  getComparisonQueryKey,
  useSubmitEvaluation,
  type RunOut,
  type ComparisonSetOut,
  type ComparisonItemOut,
} from '@/api';
import { DemoBadge } from '@/components/demo-badge';

const DEFAULT_CRITERIA = ['Evidence use', 'Rigor', 'Actionability'];

function runLabel(run: RunOut): string {
  return `Run ${run.id.slice(0, 8)}`;
}

export default function ProjectCompare() {
  const [, params] = useRoute('/app/projects/:projectId/:tab?');
  const projectId = params?.projectId ?? '';
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const runsQuery = useProjectRuns(projectId, { query: { enabled: Boolean(projectId), queryKey: getProjectRunsQueryKey(projectId) } });
  const completedRuns = (runsQuery.data ?? []).filter((r) => r.status === 'completed');

  const comparisonsQuery = useProjectComparisons(projectId, { query: { enabled: Boolean(projectId), queryKey: getProjectComparisonsQueryKey(projectId) } });
  const comparisons = comparisonsQuery.data ?? [];

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: getProjectComparisonsQueryKey(projectId) });

  if (!projectId) return null;

  if (openId) {
    return (
      <ComparisonDetail
        comparisonId={openId}
        onBack={() => { setOpenId(null); invalidateList(); }}
      />
    );
  }

  return (
    <div className="animate-in fade-in duration-300 max-w-6xl mx-auto pb-12 p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Compare Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Blinded, rubric-scored evaluation of multiple completed runs.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          disabled={completedRuns.length < 2}
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" /> New Comparison
        </button>
      </header>

      {runsQuery.isLoading || comparisonsQuery.isLoading ? (
        <div className="space-y-4">
          {[0, 1].map((i) => <div key={i} className="vls-glass rounded-xl h-24 animate-pulse bg-muted/30" />)}
        </div>
      ) : comparisonsQuery.isError ? (
        <div className="vls-glass rounded-xl p-12 text-center border border-destructive/30 bg-destructive/5">
          <XCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">Could not load comparisons.</p>
          <button onClick={() => comparisonsQuery.refetch()} className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold">
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {completedRuns.length < 2 && (
            <div className="vls-glass rounded-xl p-12 text-center border-dashed">
              <GitMerge className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-50" />
              <h2 className="text-lg font-display font-semibold mb-1">Not enough completed runs</h2>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                You need at least two completed runs in this project to create a comparison.
              </p>
            </div>
          )}

          {comparisons.length > 0 && (
            <div className="grid grid-cols-1 gap-4">
              {comparisons.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setOpenId(c.id)}
                  className="vls-glass p-5 rounded-xl border border-border text-left hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <GitMerge className="w-4 h-4 text-secondary" />
                    <span className="font-semibold">{c.name}</span>
                    {c.revealed ? (
                      <span className="text-xs bg-accent/10 text-accent px-2 py-0.5 rounded font-mono inline-flex items-center gap-1"><Eye className="w-3 h-3" /> REVEALED</span>
                    ) : (
                      <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono inline-flex items-center gap-1"><EyeOff className="w-3 h-3" /> BLINDED</span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">{format(new Date(c.created_at), 'PP')}</span>
                  </div>
                  {c.description && <p className="text-sm text-muted-foreground mb-2">{c.description}</p>}
                  <div className="text-xs text-muted-foreground flex items-center gap-3">
                    <span>{c.items?.length ?? 0} candidates</span>
                    <span>•</span>
                    <span>{c.evaluation_count ?? 0} evaluations</span>
                    {c.my_evaluation_submitted && <><span>•</span><span className="text-accent">You submitted</span></>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {comparisons.length === 0 && completedRuns.length >= 2 && (
            <div className="vls-glass rounded-xl p-12 text-center border-dashed">
              <GitMerge className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-sm text-muted-foreground">No comparisons yet. Create one to get started.</p>
            </div>
          )}
        </div>
      )}

      {creating && (
        <CreateComparisonDrawer
          projectId={projectId}
          runs={completedRuns}
          onClose={() => setCreating(false)}
          onDone={(id) => { setCreating(false); invalidateList(); setOpenId(id); }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Create drawer
// -------------------------------------------------------------------------

function CreateComparisonDrawer({
  projectId, runs, onClose, onDone,
}: { projectId: string; runs: RunOut[]; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string[]>(DEFAULT_CRITERIA);
  const [criteriaText, setCriteriaText] = useState(DEFAULT_CRITERIA.join(', '));

  const create = useCreateComparison();

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 4) return prev;
      return [...prev, id];
    });
  };

  const submit = async () => {
    const rubric = criteriaText.split(',').map((s) => s.trim()).filter(Boolean);
    setCriteria(rubric);
    const result: ComparisonSetOut = await create.mutateAsync({
      projectId,
      data: {
        name: name.trim(),
        description: description.trim() || undefined,
        run_ids: selected,
        rubric_criteria: rubric.length > 0 ? rubric : undefined,
      },
    });
    onDone(result.id);
  };

  const canSubmit = Boolean(name.trim()) && selected.length >= 2 && selected.length <= 4;

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex justify-end">
      <div className="w-full max-w-md h-full bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right">
        <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-lg font-display font-semibold">New Comparison</h2>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm min-h-[70px] focus:ring-2 focus:ring-primary/50 outline-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Rubric criteria (comma-separated)</label>
            <input
              type="text"
              value={criteriaText}
              onChange={(e) => setCriteriaText(e.target.value)}
              className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Runs to compare (2–4) — {selected.length} selected</label>
            <div className="space-y-2">
              {runs.map((run) => {
                const isSel = selected.includes(run.id);
                return (
                  <label
                    key={run.id}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                      isSel ? 'border-primary bg-primary/5' : 'border-border bg-background hover:border-primary/50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(run.id)}
                      className="mt-0.5 w-4 h-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-sm">{runLabel(run)}</div>
                      <div className="text-xs text-muted-foreground">
                        {format(new Date(run.created_at), 'PP')} • {run.provider_call_count} calls
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {create.isError && <p className="text-sm text-destructive">Could not create the comparison. Ensure all runs are completed with summaries.</p>}
        </div>

        <div className="p-4 border-t border-border shrink-0 flex justify-end">
          <button
            onClick={submit}
            disabled={!canSubmit || create.isPending}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50"
          >
            {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Create
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Comparison detail + evaluation
// -------------------------------------------------------------------------

function ComparisonDetail({ comparisonId, onBack }: { comparisonId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const q = useComparison(comparisonId, { query: { enabled: Boolean(comparisonId), queryKey: getComparisonQueryKey(comparisonId) } });
  const submit = useSubmitEvaluation();

  const [scores, setScores] = useState<Record<string, Record<string, number>>>({});
  const [ranking, setRanking] = useState<string[]>([]);
  const [comments, setComments] = useState('');

  const cset = q.data;
  const items: ComparisonItemOut[] = cset?.items ?? [];
  const criteria = ((cset?.rubric as any)?.criteria as string[] | undefined) ?? [];
  const alreadySubmitted = cset?.my_evaluation_submitted ?? false;

  // Demo runs produce simulated summaries that must never be read or ranked as
  // real results. The server sends demo_mode on every item, blinded or not: it
  // reveals nothing about which run a candidate is, and a reviewer scoring a
  // blinded set has to know when a candidate is simulated.
  const isDemoItem = (item: ComparisonItemOut): boolean => Boolean(item.demo_mode);
  const isInvalidItem = (item: ComparisonItemOut): boolean =>
    Boolean(item.validation_status && item.validation_status !== 'valid');

  const setScore = (label: string, criterion: string, value: number) => {
    setScores((prev) => ({
      ...prev,
      [label]: { ...(prev[label] ?? {}), [criterion]: value },
    }));
  };

  const toggleRank = (label: string) => {
    setRanking((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  };

  const doSubmit = async () => {
    await submit.mutateAsync({
      comparisonId,
      data: {
        item_scores: scores,
        ranking: ranking.length === items.length ? ranking : undefined,
        comments_markdown: comments.trim() || undefined,
      },
    });
    // Re-fetch so revealed identities appear.
    await queryClient.invalidateQueries({ queryKey: getComparisonQueryKey(comparisonId) });
  };

  const allScored =
    items.length > 0 &&
    criteria.length > 0 &&
    items.every((it) =>
      criteria.every((c) => {
        const v = scores[it.blind_label]?.[c];
        return typeof v === 'number' && v >= 1 && v <= 5;
      }),
    );

  return (
    <div className="animate-in fade-in duration-300 max-w-6xl mx-auto pb-12 p-8 space-y-6">
      <button onClick={onBack} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> Back to comparisons
      </button>

      {q.isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : q.isError || !cset ? (
        <div className="vls-glass rounded-xl p-12 text-center border border-destructive/30 bg-destructive/5">
          <XCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">Could not load this comparison.</p>
          <button onClick={() => q.refetch()} className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold">Retry</button>
        </div>
      ) : (
        <>
          <header>
            <div className="flex items-center gap-2 mb-2">
              <h1 className="text-2xl font-display font-bold">{cset.name}</h1>
              {cset.revealed ? (
                <span className="text-xs bg-accent/10 text-accent px-2 py-0.5 rounded font-mono inline-flex items-center gap-1"><Eye className="w-3 h-3" /> REVEALED</span>
              ) : (
                <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono inline-flex items-center gap-1"><EyeOff className="w-3 h-3" /> BLINDED</span>
              )}
            </div>
            {cset.description && <p className="text-sm text-muted-foreground">{cset.description}</p>}
          </header>

          <div className="grid gap-6 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(280px, 1fr))` }}>
            {items.map((item) => {
              const rankPos = ranking.indexOf(item.blind_label);
              const sj = (item.summary_json ?? {}) as Record<string, any>;
              return (
                <div key={item.blind_label} className="vls-reading-surface rounded-xl flex flex-col border-2 border-border">
                  <div className="p-4 border-b border-border bg-background/50">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-display font-bold text-lg">Candidate {item.blind_label}</h3>
                      {isDemoItem(item) && <DemoBadge />}
                    </div>
                    {cset.revealed && item.run_id && (
                      <div className="text-xs text-muted-foreground mt-1 font-mono">
                        {item.run_title ?? `Run ${item.run_id.slice(0, 8)}`}
                      </div>
                    )}
                    {isDemoItem(item) && (
                      <div className="mt-2 text-xs text-primary bg-primary/5 border border-primary/20 rounded px-2 py-1" data-testid="text-demo-warning">
                        Simulated demo output — not a real result. Do not read or cite as fact.
                      </div>
                    )}
                    {isInvalidItem(item) && (
                      <div className="mt-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded px-2 py-1" data-testid="text-invalid-warning">
                        This summary failed schema validation. Do not score or cite it as a finding.
                      </div>
                    )}
                  </div>

                  <div className="p-4 flex-1 space-y-3 min-w-0">
                    {sj.executive_summary ? (
                      <div>
                        <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Executive summary</div>
                        <div className="text-sm text-muted-foreground max-h-48 overflow-y-auto whitespace-pre-wrap">{sj.executive_summary}</div>
                      </div>
                    ) : item.summary_markdown ? (
                      <div className="text-sm text-muted-foreground max-h-48 overflow-y-auto whitespace-pre-wrap">{item.summary_markdown}</div>
                    ) : (
                      <div className="text-sm text-muted-foreground italic">No summary available.</div>
                    )}
                  </div>

                  {!alreadySubmitted && (
                    <div className="p-4 border-t border-border bg-background/50 space-y-4">
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Rubric scoring</div>
                      {criteria.length === 0 && <p className="text-xs text-muted-foreground">No rubric criteria defined.</p>}
                      {criteria.map((c) => (
                        <div key={c} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span>{c}</span>
                            <span className="font-mono">{scores[item.blind_label]?.[c] || '-'} / 5</span>
                          </div>
                          <div className="flex gap-1">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <button
                                key={n}
                                onClick={() => setScore(item.blind_label, c, n)}
                                className={`p-0.5 ${(scores[item.blind_label]?.[c] ?? 0) >= n ? 'text-primary' : 'text-muted-foreground/40'}`}
                                aria-label={`${c} ${n}`}
                              >
                                <Star className="w-4 h-4" fill={(scores[item.blind_label]?.[c] ?? 0) >= n ? 'currentColor' : 'none'} />
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                      <button
                        onClick={() => toggleRank(item.blind_label)}
                        className={`w-full py-2 rounded-lg text-sm font-semibold transition-all ${
                          rankPos >= 0 ? 'bg-primary text-primary-foreground' : 'bg-background border border-border hover:border-primary/50'
                        }`}
                      >
                        {rankPos >= 0 ? (
                          <span className="flex items-center justify-center gap-2"><Check className="w-4 h-4" /> Rank #{rankPos + 1}</span>
                        ) : (
                          'Add to ranking'
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {alreadySubmitted ? (
            <div className="vls-glass p-6 rounded-xl border border-accent/30 text-center">
              <Check className="w-8 h-8 text-accent mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                You have submitted your evaluation. Candidate identities are now
                {cset.revealed ? ' revealed above.' : ' hidden.'}
              </p>
            </div>
          ) : (
            <div className="vls-glass p-6 rounded-xl border border-primary/30 space-y-4">
              <h3 className="font-semibold">Comments</h3>
              <textarea
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-primary outline-none"
                placeholder="Overall rationale for your scoring and ranking…"
                value={comments}
                onChange={(e) => setComments(e.target.value)}
              />
              {submit.isError && <p className="text-sm text-destructive">Could not submit evaluation. Ensure every candidate is scored on every criterion.</p>}
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">
                  {ranking.length === items.length ? 'Ranking complete.' : 'Ranking optional (rank all candidates to include it).'}
                </p>
                <button
                  onClick={doSubmit}
                  disabled={!allScored || submit.isPending}
                  className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50"
                >
                  {submit.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Submit Evaluation
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
