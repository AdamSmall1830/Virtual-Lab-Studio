import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'wouter';
import { useGetRun, useListRunEvents, useControlRun, getGetRunQueryKey, getListRunEventsQueryKey } from '@workspace/api-client-react';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Button } from '@/components/ui/button';
import { RunStatusBadge } from '@/components/ui/run-status-badge';
import { Pause, Play, XSquare, Activity, Users, MessageSquarePlus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';

// 'paused' must stay in the polling set: control actions (resume/intervene) and
// state changes still need to reach the UI while a run is paused.
const ACTIVE_STATUSES = ['queued', 'validating', 'running', 'pause_pending', 'paused', 'cancelling'];

export default function LiveMeetingRoom() {
  const { runId } = useParams<{ runId: string }>();
  
  const { data: run, refetch: refetchRun } = useGetRun(runId, { 
    query: { enabled: !!runId, queryKey: getGetRunQueryKey(runId) }
  });
  
  const isActive = run ? ACTIVE_STATUSES.includes(run.status) : true;
  
  const { data: events, refetch: refetchEvents } = useListRunEvents(runId, {
    query: { enabled: !!runId, queryKey: getListRunEventsQueryKey(runId) }
  });

  const controlRun = useControlRun();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [instruction, setInstruction] = useState('');

  // Polling logic
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      refetchRun();
      refetchEvents();
    }, 1500);
    return () => clearInterval(interval);
  }, [isActive, refetchRun, refetchEvents]);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [events]);

  if (!run) return <div className="p-8 animate-pulse text-muted-foreground">Loading live room...</div>;

  const handleControl = (action: 'pause' | 'resume' | 'cancel') => {
    controlRun.mutate(
      { runId, data: { action } },
      { onSettled: () => { refetchRun(); refetchEvents(); } },
    );
  };

  const handleIntervene = () => {
    const text = instruction.trim();
    if (!text) return;
    controlRun.mutate(
      { runId, data: { action: 'intervene', instruction: text } },
      { onSuccess: () => setInstruction(''), onSettled: () => { refetchRun(); refetchEvents(); } },
    );
  };

  const canIntervene = ['queued', 'validating', 'running', 'paused'].includes(run?.status ?? '');

  const completedTurns = events?.filter(e => e.type === 'turn.completed') || [];

  return (
    <div className="h-full flex flex-col bg-background/50 relative overflow-hidden font-sans">
      <header className="px-6 py-4 border-b border-border/50 vls-glass flex flex-col md:flex-row md:items-center justify-between z-10 shrink-0 gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-foreground mb-1">{run.title}</h1>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <RunStatusBadge status={run.status} isSimulation={run.isSimulation} />
            <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> Round {run.currentRound} / {run.rounds}</span>
            <span>{run.callCount} / {run.plannedCallCount || '?'} calls</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {run.status === 'running' && (
            <Button variant="outline" size="sm" onClick={() => handleControl('pause')} disabled={controlRun.isPending}>
              <Pause className="w-4 h-4 mr-2" /> Pause
            </Button>
          )}
          {run.status === 'paused' && (
            <Button variant="outline" size="sm" onClick={() => handleControl('resume')} disabled={controlRun.isPending}>
              <Play className="w-4 h-4 mr-2" /> Resume
            </Button>
          )}
          {['queued', 'validating', 'running', 'paused'].includes(run.status) && (
            <Button variant="destructive" size="sm" onClick={() => handleControl('cancel')} disabled={controlRun.isPending}>
              <XSquare className="w-4 h-4 mr-2" /> Cancel
            </Button>
          )}
        </div>
      </header>

      {canIntervene && (
        <div className="px-6 py-3 border-b border-border/50 vls-glass flex items-center gap-2 shrink-0" data-testid="intervention-bar">
          <MessageSquarePlus className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
          <Input
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleIntervene(); }}
            placeholder="Add an instruction for the team (applied at the next safe checkpoint)…"
            aria-label="Instruction for the team"
            className="vls-glass h-9"
            data-testid="input-intervention"
          />
          <Button size="sm" variant="secondary" onClick={handleIntervene} disabled={controlRun.isPending || !instruction.trim()} data-testid="button-add-instruction">
            Add Instruction
          </Button>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        {/* Desktop Left: Visualization / Agent Nodes */}
        <div className="hidden lg:flex w-1/3 border-r border-border/50 flex-col p-6 vls-app-background overflow-y-auto">
          <h3 className="font-display font-semibold mb-6 flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" /> Active Team
          </h3>
          
          <div className="flex-1 relative flex flex-col items-center justify-start gap-6 py-4">
            {run.participants.map((p, i) => {
              const isSpeaking = run.currentSpeaker === p.agentId && run.status === 'running';
              return (
                <div key={i} className={`w-full max-w-[240px] p-4 rounded-xl border transition-all duration-300 ${isSpeaking ? 'bg-primary/10 border-primary shadow-[0_0_15px_rgba(var(--color-primary),0.2)]' : 'bg-surface-strong border-border/50 opacity-70'}`}>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 font-semibold">{p.roleType}</div>
                  <div className="font-display font-bold">{p.title}</div>
                  {isSpeaking && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-primary font-medium">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                      </span>
                      Synthesizing...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Transcript */}
        <div className="flex-1 flex flex-col bg-background relative">
          {/* Mobile Agent Strip */}
          <div className="lg:hidden flex overflow-x-auto p-4 gap-3 border-b border-border/50 bg-surface-strong shrink-0">
            {run.participants.map((p, i) => {
              const isSpeaking = run.currentSpeaker === p.agentId && run.status === 'running';
              return (
                <div key={i} className={`shrink-0 p-2 px-3 rounded-lg border text-sm whitespace-nowrap ${isSpeaking ? 'bg-primary/10 border-primary text-primary' : 'bg-background border-border text-muted-foreground'}`}>
                  {isSpeaking && <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary mr-2 animate-pulse" />}
                  {p.title}
                </div>
              );
            })}
          </div>

          <div ref={transcriptRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
            
            {/* System Start Node */}
            <div className="flex flex-col items-center text-center my-4">
              <div className="px-3 py-1 rounded-full bg-surface-strong border border-border text-xs text-muted-foreground font-medium mb-4">
                Meeting Initialized • {run.startedAt ? format(new Date(run.startedAt), 'HH:mm:ss') : 'Pending'}
              </div>
              <GlassPanel className="p-4 w-full max-w-2xl text-left border-l-4 border-l-primary/50 text-sm">
                <strong>Objective:</strong> {run.agendaObjective || 'No objective provided.'}
              </GlassPanel>
            </div>

            {completedTurns.map((turn, i) => {
              const participant = run.participants.find(p => p.agentId === turn.agentId);
              const content = turn.content || (turn.payload?.content as string) || '';
              
              return (
                <div key={turn.id} className="max-w-3xl mx-auto w-full flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm ml-2">
                    <span className="font-semibold text-foreground">{turn.agentTitle || participant?.title || 'System'}</span>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{turn.roleType || participant?.roleType}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{format(new Date(turn.createdAt), 'HH:mm')}</span>
                  </div>
                  <GlassPanel className="p-5 text-sm leading-relaxed prose prose-invert max-w-none prose-p:my-2 prose-pre:bg-muted/50 prose-pre:border prose-pre:border-border">
                    <div className="whitespace-pre-wrap">{content}</div>
                  </GlassPanel>
                </div>
              );
            })}

            {run.status === 'running' && (
               <div className="max-w-3xl mx-auto w-full flex items-start gap-4 animate-pulse opacity-60 mt-8">
                 <div className="w-8 h-8 rounded-full bg-primary/20 shrink-0 mt-2"></div>
                 <GlassPanel className="p-4 flex-1 h-24 flex items-center justify-center text-muted-foreground border-dashed">
                   Generating next turn...
                 </GlassPanel>
               </div>
            )}

            {['completed', 'failed', 'cancelled', 'budget_exceeded'].includes(run.status) && (
              <div className="flex flex-col items-center text-center my-8">
                <div className="px-3 py-1 rounded-full bg-surface-strong border border-border text-xs text-muted-foreground font-medium">
                  Meeting Ended • {run.status.toUpperCase()}
                </div>
              </div>
            )}

          </div>
        </div>
      </main>
    </div>
  );
}
