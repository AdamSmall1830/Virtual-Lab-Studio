import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRoute, Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Pause, Play, Square, MessageSquare, AlertTriangle,
  Activity, Zap, Cpu, CheckCircle2, Loader2, Send,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useSession } from '@/api/session';
import { subscribeRunEvents } from '@/api/sse';
import { LiveRecursivePanel } from '@/components/recursive/live-recursive-panel';
import {
  useRun,
  getRunQueryKey,
  getRunTurnsQueryKey,
  getRunSummaryQueryKey,
  usePauseRun,
  useResumeRun,
  useCancelRun,
  useAddIntervention,
  type RunEventOut,
  type RunOut,
} from '@/api';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_stopped']);
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);

interface TranscriptTurn {
  turnId: string;
  sequence: number;
  round: number;
  agentTitle: string;
  roleType: string;
  content: string;
  isFinal: boolean;
  simulation: boolean;
  done: boolean;
}

interface RoundMarker {
  kind: 'round';
  round: number;
  isFinal: boolean;
  seq: number;
}
interface InterventionMarker {
  kind: 'intervention';
  id: string;
  content: string;
  checkpoint: string;
  seq: number;
}
type StatusMarker = { kind: 'status'; label: string; seq: number };

function errStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    return (err as { status?: number }).status;
  }
  return undefined;
}

function errMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

export default function LiveRoom() {
  const [, params] = useRoute('/app/runs/:runId/live');
  const runId = params?.runId ?? '';
  const { workspaceId } = useSession();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [events, setEvents] = useState<RunEventOut[]>([]);
  const [interventionText, setInterventionText] = useState('');
  // Bumped on every SSE reconnect. Views that keep server-owned state (the
  // recursive tree) re-read it instead of trusting what they accumulated,
  // because a gap in the stream is invisible from the events themselves.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const seenSeq = useRef<Set<number>>(new Set());
  const lastSeqRef = useRef(0);

  const runQuery = useRun(runId, {
    query: {
      queryKey: getRunQueryKey(runId),
      enabled: Boolean(runId) && Boolean(workspaceId),
      refetchInterval: (query) => {
        const data = query.state.data as RunOut | undefined;
        return data && TERMINAL.has(data.status) ? false : 5000;
      },
    },
  });
  const run = runQuery.data;
  const isTerminal = run ? TERMINAL.has(run.status) : false;

  const pauseRun = usePauseRun();
  const resumeRun = useResumeRun();
  const cancelRun = useCancelRun();
  const addIntervention = useAddIntervention();

  const pushEvents = (incoming: RunEventOut[]) => {
    setEvents((prev) => {
      const next = [...prev];
      let changed = false;
      for (const ev of incoming) {
        if (seenSeq.current.has(ev.run_sequence)) continue;
        seenSeq.current.add(ev.run_sequence);
        lastSeqRef.current = Math.max(lastSeqRef.current, ev.run_sequence);
        next.push(ev);
        changed = true;
      }
      return changed ? next.sort((a, b) => a.run_sequence - b.run_sequence) : prev;
    });
  };

  // Subscribe to the live stream (with replay from 0) once per run.
  useEffect(() => {
    if (!runId || !workspaceId) return;
    seenSeq.current = new Set();
    lastSeqRef.current = 0;
    setEvents([]);
    setReconnectNonce(0);

    let active = true;
    const handle = subscribeRunEvents(runId, {
      lastEventId: 0,
      onEvent: (ev) => {
        if (!active) return;
        pushEvents([ev]);
        const type = ev.event_type;
        if (
          type === 'turn.completed' ||
          type === 'summary.completed' ||
          TERMINAL_EVENTS.has(type)
        ) {
          void queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) });
          void queryClient.invalidateQueries({ queryKey: getRunTurnsQueryKey(runId) });
          if (type === 'summary.completed') {
            void queryClient.invalidateQueries({ queryKey: getRunSummaryQueryKey(runId) });
          }
        }
        if (type === 'run.paused' || type === 'run.resumed' || type === 'human.intervention_added') {
          void queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) });
        }
      },
      onDone: () => {
        if (!active) return;
        void queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) });
      },
      onReconnect: () => {
        if (!active) return;
        setReconnectNonce((n) => n + 1);
      },
      onError: () => {
        if (!active) return;
        toast({
          title: 'Live stream interrupted',
          description: 'Falling back to polling. The transcript will keep updating.',
          variant: 'destructive',
        });
      },
    });

    return () => {
      active = false;
      handle.close();
    };
  }, [runId, workspaceId, queryClient]);

  // Derive the transcript timeline from the accumulated event stream.
  const timeline = useMemo(() => {
    const turns = new Map<string, TranscriptTurn>();
    const markers: (RoundMarker | InterventionMarker | StatusMarker)[] = [];

    for (const ev of events) {
      const p = ev.payload as Record<string, unknown>;
      switch (ev.event_type) {
        case 'round.started': {
          markers.push({
            kind: 'round',
            round: Number(p.round ?? 0),
            isFinal: Boolean(p.is_final_round),
            seq: ev.run_sequence,
          });
          break;
        }
        case 'turn.started': {
          const turnId = String(p.turn_id ?? '');
          if (!turnId) break;
          if (!turns.has(turnId)) {
            turns.set(turnId, {
              turnId,
              sequence: Number(p.sequence ?? ev.run_sequence),
              round: Number(p.round ?? 0),
              agentTitle: String(p.agent_title ?? 'Agent'),
              roleType: String(p.role_type ?? ''),
              content: '',
              isFinal: Boolean(p.is_final),
              simulation: Boolean(p.simulation),
              done: false,
            });
          }
          break;
        }
        case 'turn.delta': {
          const turnId = String(p.turn_id ?? '');
          const t = turns.get(turnId);
          if (t && !t.done) t.content += String(p.text ?? '');
          break;
        }
        case 'turn.completed': {
          const turnId = String(p.turn_id ?? '');
          const t = turns.get(turnId);
          if (t) {
            t.content = String(p.text ?? t.content);
            t.done = true;
          } else {
            turns.set(turnId, {
              turnId,
              sequence: Number(p.sequence ?? ev.run_sequence),
              round: Number(p.round ?? 0),
              agentTitle: String(p.agent_title ?? 'Agent'),
              roleType: String(p.role_type ?? ''),
              content: String(p.text ?? ''),
              isFinal: false,
              simulation: Boolean(p.simulation),
              done: true,
            });
          }
          break;
        }
        case 'human.intervention_added': {
          markers.push({
            kind: 'intervention',
            id: String(p.intervention_id ?? ev.run_sequence),
            content: String(p.content ?? 'Human intervention applied'),
            checkpoint: String(p.applied_at_checkpoint ?? ''),
            seq: ev.run_sequence,
          });
          break;
        }
        case 'run.paused':
          markers.push({ kind: 'status', label: 'Run paused', seq: ev.run_sequence });
          break;
        case 'run.resumed':
          markers.push({ kind: 'status', label: 'Run resumed', seq: ev.run_sequence });
          break;
        case 'budget.warning':
          markers.push({ kind: 'status', label: 'Budget warning', seq: ev.run_sequence });
          break;
        default:
          break;
      }
    }

    type Item =
      | { kind: 'turn'; seq: number; turn: TranscriptTurn }
      | RoundMarker
      | InterventionMarker
      | StatusMarker;

    const items: Item[] = [
      ...Array.from(turns.values()).map((turn) => ({
        kind: 'turn' as const,
        seq: turn.sequence,
        turn,
      })),
      ...markers,
    ];
    // Turns use their small sequence index; markers use run_sequence. Interleave
    // by keeping markers roughly in stream order relative to turns.
    items.sort((a, b) => {
      const sa = a.kind === 'turn' ? a.seq : a.seq;
      const sb = b.kind === 'turn' ? b.seq : b.seq;
      return sa - sb;
    });
    return items;
  }, [events]);

  // Auto-scroll to newest content.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const handleControlError = (err: unknown, action: string) => {
    if (errStatus(err) === 409) {
      toast({
        title: `Cannot ${action} right now`,
        description: 'The run already changed state. Refreshing status…',
      });
      void queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) });
      return;
    }
    toast({
      title: `Failed to ${action} run`,
      description: errMessage(err, 'An unexpected error occurred.'),
      variant: 'destructive',
    });
  };

  const doPause = () => {
    pauseRun.mutate(
      { runId },
      {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) }),
        onError: (err) => handleControlError(err, 'pause'),
      },
    );
  };
  const doResume = () => {
    resumeRun.mutate(
      { runId },
      {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) }),
        onError: (err) => handleControlError(err, 'resume'),
      },
    );
  };
  const doCancel = () => {
    if (!window.confirm('Cancel this run? This cannot be undone.')) return;
    cancelRun.mutate(
      { runId },
      {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) }),
        onError: (err) => handleControlError(err, 'cancel'),
      },
    );
  };
  const submitIntervention = () => {
    const content = interventionText.trim();
    if (!content) return;
    addIntervention.mutate(
      { runId, data: { kind: 'instruction', content } },
      {
        onSuccess: () => {
          setInterventionText('');
          toast({ title: 'Intervention queued', description: 'It will apply at the next checkpoint.' });
          void queryClient.invalidateQueries({ queryKey: getRunQueryKey(runId) });
        },
        onError: (err) => handleControlError(err, 'add intervention to'),
      },
    );
  };

  // ---- Loading / error / not-found gates ------------------------------------
  if (!runId) {
    return <div className="p-8 text-center text-muted-foreground">No run specified.</div>;
  }
  if (runQuery.isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm">Loading meeting room…</p>
      </div>
    );
  }
  if (runQuery.isError || !run) {
    return (
      <div className="max-w-md mx-auto mt-16 vls-glass rounded-xl p-8 text-center border border-destructive/30 bg-destructive/5">
        <AlertTriangle className="w-10 h-10 text-destructive mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-2">Run not available</h2>
        <p className="text-sm text-muted-foreground mb-4">
          This run could not be loaded. It may not exist or you may not have access.
        </p>
        <Link
          href="/app/runs"
          className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/90 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to runs
        </Link>
      </div>
    );
  }

  const isPaused = run.status === 'paused';
  const isPausing = run.status === 'pausing';
  const isCancelling = run.status === 'cancelling';
  const canControl = !isTerminal;
  const tokens = (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
  const failed = run.status === 'failed' || run.status === 'budget_stopped';

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] animate-in fade-in duration-500 overflow-hidden relative">
      {run.demo_mode && (
        <div className="absolute top-0 right-0 z-50 bg-primary text-primary-foreground px-3 py-1 rounded-bl-xl font-mono text-xs font-bold shadow-lg shadow-primary/20 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          Simulation — Demo Provider
        </div>
      )}

      {/* Header */}
      <header className="shrink-0 pb-4 border-b border-border flex items-center justify-between mb-4 mt-2 px-2">
        <div className="flex items-center gap-4">
          <Link
            href={`/app/runs/${run.id}`}
            className="text-muted-foreground hover:text-foreground transition-colors p-2 -ml-2 rounded-lg hover:bg-background/50"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-xl font-display font-bold line-clamp-1">Run {run.id.slice(0, 8)}</h1>
            <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
              <span className="uppercase tracking-wider font-semibold text-primary">
                {run.status.replace(/_/g, ' ')}
              </span>
              <span>•</span>
              <span>Round {run.current_round}</span>
              <span>•</span>
              <span className="font-mono">{Number(run.wall_seconds ?? 0).toFixed(0)}s elapsed</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden lg:flex items-center gap-4 px-4 py-1.5 rounded-full vls-glass text-xs font-mono">
            <div className="flex items-center gap-1.5" title="Provider Calls">
              <Activity className="w-3.5 h-3.5 text-primary" /> {run.provider_call_count}
            </div>
            <div className="w-px h-3 bg-border" />
            <div className="flex items-center gap-1.5" title="Tokens">
              <Cpu className="w-3.5 h-3.5 text-secondary" /> {tokens.toLocaleString()}
            </div>
          </div>

          {canControl && (
            <div className="flex items-center gap-2 border-l border-border pl-3 ml-1">
              {isPaused || isPausing ? (
                <button
                  onClick={doResume}
                  disabled={isPausing || resumeRun.isPending}
                  title="Resume"
                  className="bg-primary text-primary-foreground p-2 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {resumeRun.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 fill-current" />
                  )}
                </button>
              ) : (
                <button
                  onClick={doPause}
                  disabled={pauseRun.isPending}
                  title="Pause"
                  className="bg-warning text-warning-foreground p-2 rounded-lg hover:bg-warning/90 transition-colors disabled:opacity-50"
                >
                  {pauseRun.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Pause className="w-4 h-4 fill-current" />
                  )}
                </button>
              )}
              <button
                onClick={doCancel}
                disabled={cancelRun.isPending || isCancelling}
                title="Cancel"
                className="bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground p-2 rounded-lg transition-colors disabled:opacity-50"
              >
                {cancelRun.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Square className="w-4 h-4 fill-current" />
                )}
              </button>
            </div>
          )}
          {isTerminal && (
            <Link
              href={`/app/runs/${run.id}`}
              className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold hover:bg-foreground/90 transition-colors"
            >
              View Run Details
            </Link>
          )}
        </div>
      </header>

      {/* Transcript */}
      <div className="flex-1 min-h-0 flex flex-col bg-background/30 rounded-xl border border-border/50 relative overflow-hidden mx-2 mb-2">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth">
          {timeline.length === 0 && !isTerminal && (
            <div className="flex justify-center py-10">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Activity className="w-4 h-4 animate-spin" /> Waiting for the meeting to begin…
              </div>
            </div>
          )}

          {timeline.map((item) => {
            if (item.kind === 'round') {
              return (
                <div key={`r-${item.seq}`} className="flex items-center gap-3 max-w-3xl mx-auto w-full">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {item.isFinal ? 'Final Synthesis' : `Round ${item.round}`}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>
              );
            }
            if (item.kind === 'intervention') {
              return (
                <div
                  key={`i-${item.id}`}
                  className="max-w-2xl mx-auto my-2 p-4 rounded-xl border-2 border-warning/30 bg-warning/5 text-center"
                >
                  <div className="inline-flex items-center gap-2 text-warning font-semibold text-sm mb-2 uppercase tracking-wider">
                    <AlertTriangle className="w-4 h-4" /> Human Intervention
                  </div>
                  <div className="text-foreground font-medium">{item.content}</div>
                  {item.checkpoint && (
                    <div className="text-xs text-muted-foreground mt-2">
                      Applied at {item.checkpoint}
                    </div>
                  )}
                </div>
              );
            }
            if (item.kind === 'status') {
              return (
                <div key={`s-${item.seq}`} className="text-center">
                  <span className="inline-block text-xs font-medium text-muted-foreground bg-muted/40 px-3 py-1 rounded-full">
                    {item.label}
                  </span>
                </div>
              );
            }
            const turn = item.turn;
            return (
              <div key={turn.turnId} className="flex flex-col gap-2 max-w-3xl">
                <div className="flex items-center gap-2 px-1">
                  <span className="font-display font-semibold text-sm">{turn.agentTitle}</span>
                  <span className="text-[10px] uppercase tracking-wider font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                    {turn.roleType}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono bg-muted/50 px-1.5 py-0.5 rounded">
                    R{turn.round}
                  </span>
                  {turn.isFinal && (
                    <span className="text-[10px] uppercase tracking-wider font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                      Synthesis
                    </span>
                  )}
                </div>
                <div className="vls-reading-surface p-4 md:p-5 rounded-2xl rounded-tl-sm shadow-sm text-[15px] leading-relaxed whitespace-pre-wrap">
                  {turn.content ? (
                    turn.content
                  ) : (
                    <span className="animate-pulse text-muted-foreground">Thinking…</span>
                  )}
                  {!turn.done && turn.content && (
                    <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary/60 align-middle animate-pulse" />
                  )}
                </div>
              </div>
            );
          })}

          {isTerminal && run.status === 'completed' && (
            <div className="max-w-2xl mx-auto my-8 p-6 rounded-xl border-2 border-accent/30 bg-accent/5 text-center">
              <div className="w-12 h-12 rounded-full bg-accent/20 text-accent flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-display font-bold mb-2">Meeting Completed</h3>
              <p className="text-muted-foreground mb-4">
                The structured summary and artifacts have been generated.
              </p>
              <Link
                href={`/app/runs/${run.id}`}
                className="bg-foreground text-background px-6 py-2 rounded-lg font-semibold text-sm hover:bg-foreground/90 transition-colors inline-block"
              >
                View Summary &amp; Report
              </Link>
            </div>
          )}

          {isTerminal && run.status === 'cancelled' && (
            <div className="max-w-2xl mx-auto my-8 p-6 rounded-xl border-2 border-muted bg-muted/10 text-center">
              <h3 className="text-lg font-display font-bold mb-2">Run Cancelled</h3>
              <p className="text-muted-foreground mb-4">This run was cancelled before completion.</p>
              <Link
                href={`/app/runs/${run.id}`}
                className="bg-foreground text-background px-6 py-2 rounded-lg font-semibold text-sm hover:bg-foreground/90 transition-colors inline-block"
              >
                View Details
              </Link>
            </div>
          )}

          {failed && (
            <div className="max-w-2xl mx-auto my-8 p-6 rounded-xl border-2 border-destructive/30 bg-destructive/5 text-center">
              <div className="w-12 h-12 rounded-full bg-destructive/20 text-destructive flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-display font-bold mb-2 text-destructive">
                {run.status === 'budget_stopped' ? 'Budget Stopped' : 'Run Failed'}
              </h3>
              <p className="text-foreground font-medium mb-2">
                {run.failure_safe_message ?? 'The run ended unexpectedly.'}
              </p>
              {run.failure_code && (
                <p className="text-xs text-muted-foreground mb-4 font-mono">Code: {run.failure_code}</p>
              )}
              <Link
                href={`/app/runs/${run.id}`}
                className="bg-foreground text-background px-6 py-2 rounded-lg font-semibold text-sm hover:bg-foreground/90 transition-colors inline-block"
              >
                View Details
              </Link>
            </div>
          )}

          {/* Recursive execution — renders nothing unless this run has
              recursive turns, so standard runs are unaffected. */}
          <div className="max-w-3xl mx-auto w-full">
            <LiveRecursivePanel
              runId={runId}
              events={events}
              reconnectNonce={reconnectNonce}
              demoMode={Boolean(run.demo_mode)}
            />
          </div>
        </div>

        {/* Intervention bar */}
        {canControl && (
          <div className="shrink-0 p-4 border-t border-border bg-background">
            <div className="max-w-3xl mx-auto flex items-center gap-3">
              <div className="flex-1 flex items-center gap-2 bg-background border border-border rounded-lg px-3">
                <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  value={interventionText}
                  onChange={(e) => setInterventionText(e.target.value)}
                  placeholder="Inject an instruction — applied at the next safe checkpoint…"
                  className="flex-1 bg-transparent py-3 text-sm focus:outline-none"
                  onKeyDown={(e) => e.key === 'Enter' && submitIntervention()}
                />
              </div>
              <button
                onClick={submitIntervention}
                disabled={!interventionText.trim() || addIntervention.isPending}
                className="bg-primary text-primary-foreground px-5 py-3 rounded-lg font-semibold text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0 flex items-center gap-2"
              >
                {addIntervention.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                Intervene
              </button>
            </div>
          </div>
        )}

        {isPausing && (
          <div className="shrink-0 p-2 text-center text-xs font-semibold text-warning bg-warning/10 border-t border-warning/20">
            Pause requested — taking effect at the next safe checkpoint…
          </div>
        )}
        {isCancelling && (
          <div className="shrink-0 p-2 text-center text-xs font-semibold text-destructive bg-destructive/10 border-t border-destructive/20">
            Cancellation requested — stopping at the next safe checkpoint…
          </div>
        )}
      </div>
    </div>
  );
}
