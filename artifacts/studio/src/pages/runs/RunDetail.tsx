import React from 'react';
import { useParams, Link } from 'wouter';
import { useGetRun, useListRunEvents, getGetRunQueryKey, getListRunEventsQueryKey } from '@workspace/api-client-react';
import { GlassPanel } from '@/components/ui/glass-panel';
import { ArrowLeft, FileText, MessagesSquare, Zap, Clock, Users } from 'lucide-react';
import { RunStatusBadge } from '@/components/ui/run-status-badge';
import { format } from 'date-fns';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const { data: run, isLoading: loadingRun } = useGetRun(runId, { query: { enabled: !!runId, queryKey: getGetRunQueryKey(runId) }});
  const { data: events, isLoading: loadingEvents } = useListRunEvents(runId, { query: { enabled: !!runId, queryKey: getListRunEventsQueryKey(runId) }});

  if (loadingRun) return <div className="p-8 max-w-5xl mx-auto w-full animate-pulse h-12 bg-muted/50 rounded w-1/3"></div>;
  if (!run) return <div className="p-8 max-w-5xl mx-auto text-center text-muted-foreground">Run not found</div>;

  const completedTurns = events?.filter(e => e.type === 'turn.completed') || [];
  const summaryObj = run.summary as Record<string, any>;

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto w-full">
      <Link href="/app/runs" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Runs
      </Link>
      
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground mb-2">{run.title}</h1>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <RunStatusBadge status={run.status} isSimulation={run.isSimulation} />
            <span className="flex items-center gap-1"><Clock className="w-4 h-4" /> {format(new Date(run.createdAt), 'MMM d, yyyy HH:mm')}</span>
            <span className="flex items-center gap-1"><Users className="w-4 h-4" /> {run.participants.length} roles</span>
          </div>
        </div>
      </div>

      <Tabs defaultValue="summary" className="w-full">
        <TabsList className="mb-6 vls-glass p-1">
          <TabsTrigger value="summary" className="rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow"><FileText className="w-4 h-4 mr-2" /> Synthesis</TabsTrigger>
          <TabsTrigger value="transcript" className="rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow"><MessagesSquare className="w-4 h-4 mr-2" /> Transcript ({completedTurns.length})</TabsTrigger>
          <TabsTrigger value="usage" className="rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow"><Zap className="w-4 h-4 mr-2" /> Usage</TabsTrigger>
        </TabsList>

        <TabsContent value="summary">
          {run.status !== 'completed' ? (
            <GlassPanel className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2">
              <FileText className="w-8 h-8 opacity-20" />
              <p>Synthesis artifact is only generated upon successful completion.</p>
            </GlassPanel>
          ) : !summaryObj ? (
             <GlassPanel className="p-8 text-center text-muted-foreground">Summary data missing.</GlassPanel>
          ) : (
            <div className="space-y-6">
              <GlassPanel className="p-6 border-l-4 border-l-primary/50">
                <h3 className="text-xl font-display font-bold mb-3">Executive Summary</h3>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{summaryObj.executive_summary || summaryObj.executiveSummary || 'No summary available'}</p>
              </GlassPanel>

              {summaryObj.recommendation && (
                <GlassPanel className="p-6 border-l-4 border-l-accent/50">
                  <h3 className="font-semibold mb-2">Recommendation</h3>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{String(summaryObj.recommendation)}</p>
                </GlassPanel>
              )}

              {Array.isArray(summaryObj.answers_to_required_questions) && summaryObj.answers_to_required_questions.length > 0 && (
                <GlassPanel className="p-6">
                  <h3 className="text-lg font-display font-bold mb-4">Required Questions Answered</h3>
                  <div className="space-y-4">
                    {summaryObj.answers_to_required_questions.map((qa: any, i: number) => (
                      <div key={i} className="bg-surface-strong p-4 rounded-lg border border-border/50">
                        <div className="font-medium text-sm mb-2 text-foreground">{qa?.question}</div>
                        <div className="text-sm text-muted-foreground whitespace-pre-wrap">{qa?.answer}</div>
                      </div>
                    ))}
                  </div>
                </GlassPanel>
              )}

              {Array.isArray(summaryObj.contributions) && summaryObj.contributions.length > 0 && (
                <GlassPanel className="p-6">
                  <h3 className="text-lg font-display font-bold mb-4">Contributions by Role</h3>
                  <div className="space-y-3">
                    {summaryObj.contributions.map((c: any, i: number) => (
                      <div key={i} className="flex gap-3 text-sm">
                        <span className="font-medium text-foreground shrink-0 w-48">{c?.role}</span>
                        <span className="text-muted-foreground">{c?.contribution}</span>
                      </div>
                    ))}
                  </div>
                </GlassPanel>
              )}

              <div className="grid md:grid-cols-2 gap-6">
                <GlassPanel className="p-6 border-t-2 border-t-warning/50">
                  <h3 className="font-semibold mb-3">Disagreements</h3>
                  {Array.isArray(summaryObj.disagreements) && summaryObj.disagreements.length > 0 ? (
                    <div className="space-y-3">
                      {summaryObj.disagreements.map((d: any, i: number) => (
                        <div key={i} className="text-sm space-y-1">
                          <div className="font-medium text-foreground">{d?.topic}</div>
                          <p className="text-muted-foreground">{d?.positions}</p>
                          {d?.resolution && <p className="text-xs text-warning">{d.resolution}</p>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">None noted</p>
                  )}
                </GlassPanel>

                <GlassPanel className="p-6 border-t-2 border-t-info/50">
                  <h3 className="font-semibold mb-3">Confidence & Assumptions</h3>
                  {summaryObj.confidence && (
                    <p className="text-sm text-muted-foreground mb-3">
                      <span className="uppercase tracking-wider text-xs font-medium text-foreground mr-2">{(summaryObj.confidence as any)?.level}</span>
                      {(summaryObj.confidence as any)?.rationale}
                    </p>
                  )}
                  {Array.isArray(summaryObj.assumptions) && (
                    <ul className="text-sm text-muted-foreground list-disc pl-4 space-y-1">
                      {summaryObj.assumptions.map((a: any, i: number) => <li key={i}>{String(a)}</li>)}
                    </ul>
                  )}
                </GlassPanel>
              </div>

              {Array.isArray(summaryObj.risks_and_limitations) && summaryObj.risks_and_limitations.length > 0 && (
                <GlassPanel className="p-6 border-t-2 border-t-destructive/40">
                  <h3 className="font-semibold mb-3">Risks & Limitations</h3>
                  <ul className="text-sm text-muted-foreground list-disc pl-4 space-y-1">
                    {summaryObj.risks_and_limitations.map((r: any, i: number) => <li key={i}>{String(r)}</li>)}
                  </ul>
                </GlassPanel>
              )}

              {Array.isArray(summaryObj.next_steps) && summaryObj.next_steps.length > 0 && (
                <GlassPanel className="p-6">
                  <h3 className="text-lg font-display font-bold mb-4">Next Steps</h3>
                  <div className="space-y-3">
                    {summaryObj.next_steps.map((s: any, i: number) => (
                      <div key={i} className="bg-surface-strong p-4 rounded-lg border border-border/50 text-sm">
                        <div className="font-medium text-foreground mb-1">{i + 1}. {typeof s === 'string' ? s : s?.step}</div>
                        {s?.acceptance_criterion && (
                          <div className="text-muted-foreground text-xs">Acceptance criterion: {s.acceptance_criterion}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </GlassPanel>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="transcript">
          <GlassPanel className="p-6">
            <div className="space-y-6">
              {completedTurns.map(turn => {
                const participant = run.participants.find(p => p.agentId === turn.agentId);
                const content = turn.content || (turn.payload?.content as string) || '';
                return (
                  <div key={turn.id} className="border-b border-border/40 pb-6 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{turn.agentTitle || participant?.title}</span>
                        <span className="text-xs bg-surface-strong px-2 py-0.5 rounded border border-border uppercase tracking-wider text-muted-foreground">{turn.roleType || participant?.roleType}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{format(new Date(turn.createdAt), 'HH:mm:ss')}</span>
                    </div>
                    <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap font-sans">
                      {content}
                    </div>
                  </div>
                );
              })}
              {completedTurns.length === 0 && <div className="text-center text-muted-foreground py-8">No transcript available.</div>}
            </div>
          </GlassPanel>
        </TabsContent>

        <TabsContent value="usage">
          <div className="grid md:grid-cols-3 gap-6">
            <GlassPanel className="p-6 text-center border-t-2 border-t-primary/50">
              <div className="text-muted-foreground text-sm font-medium mb-2">API Calls</div>
              <div className="text-4xl font-display font-bold text-foreground">{run.callCount}</div>
            </GlassPanel>
            <GlassPanel className="p-6 text-center border-t-2 border-t-secondary/50">
              <div className="text-muted-foreground text-sm font-medium mb-2">Tokens Used</div>
              <div className="text-4xl font-display font-bold text-foreground">{run.tokensUsed.toLocaleString()}</div>
            </GlassPanel>
            <GlassPanel className="p-6 text-center border-t-2 border-t-accent/50">
              <div className="text-muted-foreground text-sm font-medium mb-2">Est. Cost</div>
              <div className="text-4xl font-display font-bold text-foreground">${run.estimatedCost?.toFixed(4) || '0.0000'}</div>
            </GlassPanel>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
