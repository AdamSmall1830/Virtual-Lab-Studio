import React, { useEffect, useState, useRef } from 'react';
import { useRoute, Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { subscribeToRun, requestPause, resumeRun, cancelRun, addIntervention } from '@/demo/engine';
import { 
  ArrowLeft, Pause, Play, Square, MessageSquare, AlertTriangle, 
  Activity, Zap, Clock, ShieldAlert, Cpu, CheckCircle2
} from 'lucide-react';
import type { RunEvent, RunTurn } from '@/demo/types';

export default function LiveRoom() {
  const [, params] = useRoute('/app/runs/:runId/live');
  const runId = params?.runId;
  const workspace = useWorkspace();
  const run = workspace.runs.find(r => r.id === runId);
  
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [interventionText, setInterventionText] = useState('');
  const [showDrawer, setShowDrawer] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showDrawer) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowDrawer(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showDrawer]);

  useEffect(() => {
    if (!runId) return;
    const unsub = subscribeToRun(runId, (ev) => {
      setEvents(prev => [...prev, ev]);
    }, { replayFromSeq: 0 });
    return unsub;
  }, [runId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [run?.turns, events.length]);

  if (!run) return <div className="p-8 text-center text-muted-foreground">Run not found or loading...</div>;

  const handlePause = () => requestPause(run.id);
  const handleResume = () => resumeRun(run.id);
  const handleCancel = () => cancelRun(run.id);
  const submitIntervention = () => {
    if (!interventionText.trim()) return;
    addIntervention(run.id, 'Principal Investigator', interventionText);
    setInterventionText('');
  };

  const isCompleted = ['completed', 'cancelled', 'failed'].includes(run.status);
  const isPaused = run.status === 'paused';
  const isPausePending = run.status === 'pause_pending';

  const allToolCalls = run.turns.flatMap(t => t.toolCalls.map(tc => ({ ...tc, speaker: t.speaker, round: t.round })));

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] animate-in fade-in duration-500 overflow-hidden relative">
      
      {/* Simulation Chip */}
      {run.simulated && (
        <div className="absolute top-0 right-0 z-50 bg-primary text-primary-foreground px-3 py-1 rounded-bl-xl font-mono text-xs font-bold shadow-lg shadow-primary/20 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          Simulation — Demo Provider
        </div>
      )}

      {/* Header Chrome */}
      <header className="shrink-0 pb-4 border-b border-border flex items-center justify-between mb-4 mt-2 px-2">
        <div className="flex items-center gap-4">
          <Link href={`/app/runs/${run.id}`} className="text-muted-foreground hover:text-foreground transition-colors p-2 -ml-2 rounded-lg hover:bg-background/50">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-xl font-display font-bold line-clamp-1">{run.title}</h1>
            <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
              <span className="uppercase tracking-wider font-semibold text-primary">{run.currentStage}</span>
              <span>•</span>
              <span>Round {run.currentRound} / {run.frozenDefinition.rounds}</span>
              <span>•</span>
              <span className="font-mono">{run.usage.wallSeconds}s elapsed</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden lg:flex items-center gap-4 px-4 py-1.5 rounded-full vls-glass text-xs font-mono">
            <div className="flex items-center gap-1.5" title="Provider Calls"><Activity className="w-3.5 h-3.5 text-primary" /> {run.usage.providerCalls}</div>
            <div className="w-px h-3 bg-border" />
            <div className="flex items-center gap-1.5" title="Tokens"><Cpu className="w-3.5 h-3.5 text-secondary" /> {(run.usage.tokensIn + run.usage.tokensOut).toLocaleString()}</div>
          </div>
          
          {!isCompleted && (
            <div className="flex items-center gap-2 border-l border-border pl-3 ml-1">
              {(isPaused || isPausePending) ? (
                <button onClick={handleResume} disabled={isPausePending} className="bg-primary text-primary-foreground p-2 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50">
                  <Play className="w-4 h-4 fill-current" />
                </button>
              ) : (
                <button onClick={handlePause} className="bg-warning text-warning-foreground p-2 rounded-lg hover:bg-warning/90 transition-colors">
                  <Pause className="w-4 h-4 fill-current" />
                </button>
              )}
              <button onClick={handleCancel} className="bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground p-2 rounded-lg transition-colors">
                <Square className="w-4 h-4 fill-current" />
              </button>
            </div>
          )}
          {isCompleted && (
            <Link href={`/app/runs/${run.id}`} className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold hover:bg-foreground/90 transition-colors">
              View Run Details
            </Link>
          )}
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 px-2 pb-2">
        
        {/* Left: Orbit / Visualization (Desktop) / Agent Strip (Mobile) */}
        <div className="shrink-0 lg:w-72 xl:w-80 flex flex-col gap-4">
          <div className="vls-glass rounded-xl p-4 flex-1 flex flex-col border border-primary/10">
            <h3 className="font-semibold text-sm mb-4 text-center font-display">Active Council</h3>
            
            <div className="flex-1 flex flex-col justify-center gap-3">
              {/* Simple vertical arrangement representing the circle for now */}
              <div className="p-4 rounded-lg bg-background border border-border/50 text-center relative z-10">
                <div className="text-xs font-bold text-primary uppercase tracking-wider mb-1">Agenda Context</div>
                <div className="text-sm font-medium line-clamp-2">{run.frozenDefinition.agenda}</div>
              </div>
              
              <div className="w-px h-6 bg-border mx-auto" />
              
              {run.frozenDefinition.agentSlugs.map(slug => {
                const agent = workspace.agents.find(a => a.slug === slug);
                const isActive = run.activeSpeaker === agent?.title;
                return (
                  <div key={slug} className={`p-3 rounded-lg border transition-all duration-300 ${isActive ? 'bg-primary/10 border-primary shadow-[0_0_15px_rgba(var(--primary),0.2)] scale-[1.02]' : 'bg-background border-border opacity-70'}`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded shrink-0 flex items-center justify-center ${isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                        {isActive ? <Zap className="w-4 h-4 animate-pulse" /> : <MessageSquare className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <div className={`font-semibold text-sm truncate ${isActive ? 'text-primary' : 'text-foreground'}`}>{agent?.title || slug}</div>
                        <div className="text-xs text-muted-foreground truncate">{agent?.role}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: Transcript primary column */}
        <div className="flex-1 min-w-0 flex flex-col bg-background/30 rounded-xl border border-border/50 relative overflow-hidden">
          
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth">
            {run.turns.map((turn, i) => (
              <div key={i} className={`flex flex-col gap-2 max-w-3xl ${turn.agentSlug ? '' : 'mx-auto w-full text-center'}`}>
                {turn.agentSlug && (
                  <div className="flex items-center gap-2 px-1">
                    <span className="font-display font-semibold text-sm">{turn.speaker}</span>
                    <span className="text-xs text-muted-foreground font-mono bg-muted/50 px-1.5 py-0.5 rounded">R{turn.round}</span>
                    {turn.toolCalls.length > 0 && (
                      <button onClick={() => setShowDrawer(true)} className="text-xs text-accent hover:underline flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" /> {turn.toolCalls.length} tools
                      </button>
                    )}
                  </div>
                )}
                
                <div className={`vls-reading-surface p-4 md:p-5 rounded-2xl shadow-sm text-[15px] leading-relaxed relative ${turn.agentSlug ? 'rounded-tl-sm' : 'bg-secondary/5 border-secondary/20 text-center font-medium'}`}>
                  {turn.content || <span className="animate-pulse text-muted-foreground">Thinking...</span>}
                  
                  {turn.citedEvidenceIds.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-2">
                      {turn.citedEvidenceIds.map(id => (
                        <span key={id} className="inline-flex items-center text-xs font-mono bg-accent/10 text-accent px-2 py-1 rounded border border-accent/20 cursor-pointer hover:bg-accent/20">
                          {id}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {run.interventions.map(inv => (
              <div key={inv.id} className="max-w-2xl mx-auto my-6 p-4 rounded-xl border-2 border-warning/30 bg-warning/5 text-center">
                <div className="inline-flex items-center gap-2 text-warning font-semibold text-sm mb-2 uppercase tracking-wider">
                  <AlertTriangle className="w-4 h-4" /> Human Intervention
                </div>
                <div className="text-foreground font-medium">{inv.content}</div>
                <div className="text-xs text-muted-foreground mt-2">By {inv.author} at Round {inv.round}</div>
              </div>
            ))}

            {!isCompleted && run.activeSpeaker === null && run.status === 'running' && (
              <div className="flex justify-center py-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Activity className="w-4 h-4 animate-spin" /> Orchestrating next turn...
                </div>
              </div>
            )}
            
            {isCompleted && !run.failure && (
              <div className="max-w-2xl mx-auto my-8 p-6 rounded-xl border-2 border-accent/30 bg-accent/5 text-center">
                <div className="w-12 h-12 rounded-full bg-accent/20 text-accent flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-display font-bold mb-2">Meeting Completed</h3>
                <p className="text-muted-foreground mb-4">The structural summary and artifacts have been generated.</p>
                <Link href={`/app/runs/${run.id}`} className="bg-foreground text-background px-6 py-2 rounded-lg font-semibold text-sm hover:bg-foreground/90 transition-colors inline-block">
                  View Summary & Report
                </Link>
              </div>
            )}
            
            {run.failure && (
              <div className="max-w-2xl mx-auto my-8 p-6 rounded-xl border-2 border-destructive/30 bg-destructive/5 text-center">
                <div className="w-12 h-12 rounded-full bg-destructive/20 text-destructive flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-display font-bold mb-2 text-destructive">Run Failed</h3>
                <p className="text-foreground font-medium mb-2">{run.failure.message}</p>
                <p className="text-xs text-muted-foreground mb-4 font-mono">Correlation ID: {run.failure.correlationId}</p>
                <Link href={`/app/runs/${run.id}`} className="bg-foreground text-background px-6 py-2 rounded-lg font-semibold text-sm hover:bg-foreground/90 transition-colors inline-block">
                  View Details
                </Link>
              </div>
            )}
          </div>

          {/* Intervention Bar (shows when paused) */}
          {(isPaused) && (
            <div className="shrink-0 p-4 border-t border-border bg-background">
              <div className="max-w-3xl mx-auto flex items-center gap-3">
                <input 
                  type="text" 
                  value={interventionText}
                  onChange={e => setInterventionText(e.target.value)}
                  placeholder="Inject a rule, correct an assumption, or force a pivot..."
                  className="flex-1 bg-background border border-warning/50 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-warning"
                  onKeyDown={e => e.key === 'Enter' && submitIntervention()}
                />
                <button 
                  onClick={submitIntervention}
                  disabled={!interventionText.trim()}
                  className="bg-warning text-warning-foreground px-6 py-3 rounded-lg font-bold text-sm hover:bg-warning/90 disabled:opacity-50 transition-colors shrink-0"
                >
                  Intervene
                </button>
              </div>
            </div>
          )}
          
          {isPausePending && (
            <div className="shrink-0 p-2 text-center text-xs font-semibold text-warning bg-warning/10 border-t border-warning/20">
              Pause requested — taking effect at the next safe checkpoint...
            </div>
          )}

        </div>
        
        {/* Tools Drawer */}
        {showDrawer && (
          <>
            <div className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden" onClick={() => setShowDrawer(false)} />
            
            <div className="fixed inset-y-0 right-0 z-50 w-full md:w-[450px] bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right-8">
              <div className="p-4 border-b border-border flex items-center justify-between bg-muted/20">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldAlert className="w-4 h-4 text-accent" />
                  Simulated Tool Executions
                </div>
                <button onClick={() => setShowDrawer(false)} className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors">
                  <ArrowLeft className="w-4 h-4" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {allToolCalls.length === 0 && (
                  <div className="text-sm text-muted-foreground text-center py-8">No tools executed yet.</div>
                )}
                {allToolCalls.map((tc, i) => (
                  <div key={i} className="vls-glass p-3 rounded-lg border border-border text-sm flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs bg-accent/10 text-accent px-2 py-0.5 rounded border border-accent/20">
                        {tc.tool}
                      </span>
                      <span className="text-xs text-muted-foreground font-medium">{tc.speaker} <span className="opacity-50">(R{tc.round})</span></span>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Arguments</div>
                      <pre className="text-xs bg-background p-2 rounded-md border font-mono overflow-x-auto text-foreground">
                        {JSON.stringify(tc.arguments, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Result</div>
                      <div className="text-xs bg-muted/30 p-2 rounded-md border max-h-48 overflow-y-auto">
                        {typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
