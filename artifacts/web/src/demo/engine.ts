// Virtual Lab Studio — deterministic Demo Provider run engine.
// Streams the scripted scenario from specs/demo_provider_scenario.json as
// live events (client-side simulation of the SSE stream), with pause/resume,
// cancel, checkpoints, interventions, and budget accounting.
// Every run produced here carries `simulated: true` and must be labeled
// "Simulation — Demo Provider" in the UI.

import scenarioRaw from './data/demo_provider_scenario.json';
import { getRun, getState, mutate, uid } from './store';
import type {
  Intervention,
  MeetingDraft,
  Run,
  RunEvent,
  RunTurn,
  StructuredSummary,
} from './types';

interface ScriptedCall {
  call_index: number;
  round: number;
  speaker: string;
  stage: string;
  content: string;
}

interface Scenario {
  key: string;
  meeting_title: string;
  simulated_latency_ms: {
    first_token: number;
    between_chunks: number;
    tool_call: number;
  };
  simulated_tool_events: {
    after_call_index: number;
    tool: string;
    arguments: Record<string, unknown>;
    result: unknown;
    label: string;
  }[];
  scripted_calls: ScriptedCall[];
  structured_summary: StructuredSummary;
}

const scenario = (scenarioRaw as { scenario: Scenario }).scenario;

const CHUNK_WORDS = 6;
const DEMO_COST_PER_CALL = 0; // demo provider is free

type EngineListener = (event: RunEvent) => void;

interface ActiveEngine {
  runId: string;
  timer: ReturnType<typeof setTimeout> | null;
  pauseRequested: boolean;
  paused: boolean;
  cancelled: boolean;
  resume: (() => void) | null;
  listeners: Set<EngineListener>;
  startedAtMs: number;
}

const engines = new Map<string, ActiveEngine>();

function speakerToSlug(speaker: string): string | null {
  const agent = getState().agents.find(
    (a) => a.title.toLowerCase() === speaker.toLowerCase(),
  );
  return agent ? agent.slug : null;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function emit(engine: ActiveEngine, type: RunEvent['type'], data: Record<string, unknown>): RunEvent {
  let event: RunEvent | null = null;
  mutate((s) => {
    const run = s.runs.find((r) => r.id === engine.runId);
    if (!run) return;
    event = {
      seq: run.events.length,
      type,
      at: new Date().toISOString(),
      data,
    };
    run.events.push(event);
    run.usage.wallSeconds = Math.round((Date.now() - engine.startedAtMs) / 1000);
  });
  if (event) engine.listeners.forEach((l) => l(event as RunEvent));
  return event as unknown as RunEvent;
}

function updateRun(engine: ActiveEngine, fn: (run: Run) => void): void {
  mutate((s) => {
    const run = s.runs.find((r) => r.id === engine.runId);
    if (run) fn(run);
  });
}

function wait(engine: ActiveEngine, ms: number): Promise<void> {
  return new Promise((resolve) => {
    engine.timer = setTimeout(resolve, ms);
  });
}

async function checkpoint(engine: ActiveEngine): Promise<boolean> {
  // Returns false when the run should stop (cancelled).
  if (engine.cancelled) return false;
  if (engine.pauseRequested) {
    engine.pauseRequested = false;
    engine.paused = true;
    updateRun(engine, (r) => {
      r.status = 'paused';
    });
    emit(engine, 'paused', { note: 'Paused at a safe checkpoint.' });
    await new Promise<void>((resolve) => {
      engine.resume = resolve;
    });
    engine.paused = false;
    engine.resume = null;
    if (engine.cancelled) return false;
    updateRun(engine, (r) => {
      r.status = 'running';
    });
    emit(engine, 'resumed', {});
  }
  return !engine.cancelled;
}

/** Create a run from a frozen meeting definition and start streaming it. */
/**
 * Validate a draft for launch. Returns a list of blockers (empty = launchable).
 * Enforced again inside launchRun so malformed persisted drafts cannot run.
 */
export function validateDraftForLaunch(draft: MeetingDraft): string[] {
  const blockers: string[] = [];
  if (!draft.projectId) blockers.push('Select a project for this meeting.');
  if (!draft.title.trim()) blockers.push('Give the meeting a title.');
  const minAgents = draft.meetingType === 'individual' ? 1 : 2;
  if (draft.agentSlugs.length < minAgents) {
    blockers.push(
      draft.meetingType === 'individual'
        ? 'Select at least one agent for an individual meeting.'
        : 'Select a lead and at least one specialist for a team meeting.',
    );
  }
  if (draft.meetingType !== 'individual') {
    if (!draft.leadSlug || !draft.agentSlugs.includes(draft.leadSlug))
      blockers.push('Designate a lead agent from the selected roster.');
  }
  if (draft.criticSlug && !draft.agentSlugs.includes(draft.criticSlug))
    blockers.push('The designated critic is not in the selected roster.');
  return blockers;
}

export function launchRun(draft: MeetingDraft): string {
  const blockers = validateDraftForLaunch(draft);
  if (blockers.length > 0) {
    throw new Error(`Draft is not launchable: ${blockers.join(' ')}`);
  }
  const runId = uid('run');
  const now = new Date().toISOString();
  const run: Run = {
    id: runId,
    projectId: draft.projectId,
    title: draft.title || scenario.meeting_title,
    meetingType: draft.meetingType,
    status: 'queued',
    frozenDefinition: JSON.parse(JSON.stringify({ ...draft })),
    frozenAgents: JSON.parse(
      JSON.stringify(
        getState().agents.filter((a) => draft.agentSlugs.includes(a.slug)),
      ),
    ),
    frozenEvidence: JSON.parse(
      JSON.stringify(
        getState().evidence.filter((e) =>
          draft.evidenceIds.includes(e.evidence_id),
        ),
      ),
    ),
    provider: 'demo',
    model: draft.model || 'demo-research-v1',
    simulated: true,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    currentRound: 0,
    currentStage: 'queued',
    activeSpeaker: null,
    turns: [],
    events: [],
    interventions: [],
    usage: {
      providerCalls: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      wallSeconds: 0,
    },
    summary: null,
    failure: null,
  };
  mutate((s) => {
    s.runs.unshift(run);
  });
  const engine: ActiveEngine = {
    runId,
    timer: null,
    pauseRequested: false,
    paused: false,
    cancelled: false,
    resume: null,
    listeners: new Set(),
    startedAtMs: Date.now(),
  };
  engines.set(runId, engine);
  void streamRun(engine, draft);
  return runId;
}

function budgetExceeded(engine: ActiveEngine, draft: MeetingDraft): string | null {
  const run = getRun(engine.runId);
  if (!run) return null;
  const b = draft.budgets;
  if (b.max_provider_calls > 0 && run.usage.providerCalls >= b.max_provider_calls)
    return `Provider-call budget reached (${b.max_provider_calls}).`;
  if (b.max_tool_calls > 0 && run.usage.toolCalls >= b.max_tool_calls)
    return `Tool-call budget reached (${b.max_tool_calls}).`;
  if (b.max_cost_usd > 0 && run.usage.costUsd >= b.max_cost_usd)
    return `Cost budget reached ($${b.max_cost_usd}).`;
  const wall = Math.round((Date.now() - engine.startedAtMs) / 1000);
  if (b.max_wall_seconds > 0 && wall >= b.max_wall_seconds)
    return `Wall-time budget reached (${b.max_wall_seconds}s).`;
  return null;
}

function finishBudgetStopped(engine: ActiveEngine, reason: string): void {
  updateRun(engine, (r) => {
    r.status = 'failed';
    r.completedAt = new Date().toISOString();
    r.currentStage = 'stopped';
    r.activeSpeaker = null;
    r.failure = {
      message: `Run stopped at a safe checkpoint: ${reason}`,
      correlationId: uid('corr'),
    };
  });
  emit(engine, 'run_failed', { reason, budget: true });
  engines.delete(engine.runId);
}

async function streamRun(engine: ActiveEngine, draft: MeetingDraft): Promise<void> {
  const lat = scenario.simulated_latency_ms;
  updateRun(engine, (r) => {
    r.status = 'running';
    r.startedAt = new Date().toISOString();
    r.currentStage = 'opening';
  });
  emit(engine, 'run_started', {
    provider: 'demo',
    model: draft.model,
    simulated: true,
    label: 'Simulation — deterministic Demo Provider',
  });

  const rounds = Math.max(1, draft.rounds);
  const maxRound = Math.max(...scenario.scripted_calls.map((c) => c.round));
  const calls = scenario.scripted_calls.filter(
    (c) => c.round <= Math.min(rounds + 1, maxRound) || c.stage === 'final',
  );

  let currentRound = 0;
  for (const call of calls) {
    if (!(await checkpoint(engine))) return finishCancelled(engine);
    const overBudget = budgetExceeded(engine, draft);
    if (overBudget) return finishBudgetStopped(engine, overBudget);

    if (call.round !== currentRound) {
      if (currentRound > 0) {
        emit(engine, 'round_completed', { round: currentRound });
        emit(engine, 'checkpoint', {
          round: currentRound,
          note: 'Safe checkpoint — pause or add an intervention.',
        });
        if (draft.pauseAfterRound && !engine.paused) {
          engine.pauseRequested = true;
        }
        if (!(await checkpoint(engine))) return finishCancelled(engine);
      }
      currentRound = call.round;
      updateRun(engine, (r) => {
        r.currentRound = currentRound;
        r.currentStage = call.stage === 'final' ? 'synthesis' : 'discussion';
      });
      emit(engine, 'round_started', {
        round: currentRound,
        stage: call.stage === 'final' ? 'synthesis' : 'discussion',
      });
    }

    // Turn start
    const turnIndex = call.call_index;
    const agentSlug = speakerToSlug(call.speaker);
    const startedAt = new Date().toISOString();
    const turn: RunTurn = {
      index: turnIndex,
      round: call.round,
      speaker: call.speaker,
      agentSlug,
      stage: call.stage as RunTurn['stage'],
      content: '',
      provider: 'demo',
      model: draft.model || 'demo-research-v1',
      tokensIn: estimateTokens(draft.agenda) + 180,
      tokensOut: 0,
      latencyMs: 0,
      toolCalls: [],
      citedEvidenceIds: (call.content.match(/DEMO-EVIDENCE-\d+/g) ?? []).filter(
        (v, i, arr) => arr.indexOf(v) === i,
      ),
      startedAt,
      completedAt: null,
    };
    updateRun(engine, (r) => {
      r.turns.push(turn);
      r.activeSpeaker = call.speaker;
      r.usage.providerCalls += 1;
      r.usage.tokensIn += turn.tokensIn;
    });
    emit(engine, 'turn_started', {
      turnIndex,
      round: call.round,
      speaker: call.speaker,
      agentSlug,
      stage: call.stage,
    });

    await wait(engine, lat.first_token);
    if (engine.cancelled) return finishCancelled(engine);

    // Stream content in word chunks
    const words = call.content.split(' ');
    for (let i = 0; i < words.length; i += CHUNK_WORDS) {
      if (engine.cancelled) return finishCancelled(engine);
      const chunk =
        (i > 0 ? ' ' : '') + words.slice(i, i + CHUNK_WORDS).join(' ');
      updateRun(engine, (r) => {
        const t = r.turns.find((x) => x.index === turnIndex);
        if (t) {
          t.content += chunk;
          t.tokensOut = estimateTokens(t.content);
        }
        r.usage.tokensOut += estimateTokens(chunk);
      });
      emit(engine, 'turn_delta', { turnIndex, delta: chunk });
      await wait(engine, lat.between_chunks);
    }

    // Simulated tool events attached after this call
    for (const te of scenario.simulated_tool_events.filter(
      (t) => t.after_call_index === call.call_index,
    )) {
      // Enforce the tool-call budget at the operation boundary, before the call.
      const runNow = getRun(engine.runId);
      const toolBudget = draft.budgets.max_tool_calls;
      if (runNow && toolBudget > 0 && runNow.usage.toolCalls >= toolBudget) {
        return finishBudgetStopped(
          engine,
          `Tool-call budget reached (${toolBudget}).`,
        );
      }
      await wait(engine, lat.tool_call);
      if (engine.cancelled) return finishCancelled(engine);
      updateRun(engine, (r) => {
        const t = r.turns.find((x) => x.index === turnIndex);
        if (t)
          t.toolCalls.push({
            tool: te.tool,
            arguments: te.arguments,
            result: te.result,
            label: te.label,
            latencyMs: lat.tool_call,
          });
        r.usage.toolCalls += 1;
      });
      emit(engine, 'tool_call', {
        turnIndex,
        tool: te.tool,
        label: te.label,
        arguments: te.arguments,
        result: te.result,
      });
    }

    updateRun(engine, (r) => {
      const t = r.turns.find((x) => x.index === turnIndex);
      if (t) {
        t.completedAt = new Date().toISOString();
        t.latencyMs = Date.now() - new Date(t.startedAt).getTime();
      }
      r.activeSpeaker = null;
      r.usage.costUsd += DEMO_COST_PER_CALL;
    });
    emit(engine, 'turn_completed', { turnIndex, round: call.round });
  }

  emit(engine, 'round_completed', { round: currentRound });

  // Structured summary
  updateRun(engine, (r) => {
    r.currentStage = 'summary';
    r.summary = scenario.structured_summary;
  });
  emit(engine, 'summary_ready', { simulated: true });
  await wait(engine, 400);

  updateRun(engine, (r) => {
    r.status = 'completed';
    r.completedAt = new Date().toISOString();
    r.currentStage = 'completed';
  });
  emit(engine, 'run_completed', { status: 'completed' });
  engines.delete(engine.runId);
}

function finishCancelled(engine: ActiveEngine): void {
  updateRun(engine, (r) => {
    r.status = 'cancelled';
    r.completedAt = new Date().toISOString();
    r.currentStage = 'cancelled';
    r.activeSpeaker = null;
  });
  emit(engine, 'run_cancelled', {});
  engines.delete(engine.runId);
}

// ---- controls ----------------------------------------------------------------

export function requestPause(runId: string): void {
  const engine = engines.get(runId);
  if (!engine || engine.paused) return;
  engine.pauseRequested = true;
  updateRun(engine, (r) => {
    r.status = 'pause_pending';
  });
  emit(engine, 'pause_pending', {
    note: 'Pause requested — will take effect at the next safe checkpoint.',
  });
}

export function resumeRun(runId: string): void {
  const engine = engines.get(runId);
  if (engine?.resume) engine.resume();
}

export function cancelRun(runId: string): void {
  const engine = engines.get(runId);
  if (!engine) return;
  engine.cancelled = true;
  if (engine.timer) clearTimeout(engine.timer);
  if (engine.resume) engine.resume();
  else finishCancelled(engine);
}

export function addIntervention(runId: string, author: string, content: string): void {
  const engine = engines.get(runId);
  const run = getRun(runId);
  if (!run) return;
  const intervention: Intervention = {
    id: uid('int'),
    atTurnIndex: run.turns.length,
    round: run.currentRound,
    author,
    content,
    createdAt: new Date().toISOString(),
  };
  mutate((s) => {
    const r = s.runs.find((x) => x.id === runId);
    if (r) r.interventions.push(intervention);
  });
  if (engine) {
    emit(engine, 'intervention', {
      author,
      content,
      round: run.currentRound,
    });
  }
}

/** Subscribe to live events for a running run. Also replays past events. */
export function subscribeToRun(
  runId: string,
  listener: EngineListener,
  opts?: { replayFromSeq?: number },
): () => void {
  const run = getRun(runId);
  if (run) {
    const from = opts?.replayFromSeq ?? 0;
    for (const ev of run.events.slice(from)) listener(ev);
  }
  const engine = engines.get(runId);
  if (!engine) return () => undefined;
  engine.listeners.add(listener);
  return () => engine.listeners.delete(listener);
}

export function isRunLive(runId: string): boolean {
  return engines.has(runId);
}

/** Rough pre-launch estimate mirrored from the composer review step. */
export function estimateRun(draft: MeetingDraft): {
  providerCalls: number;
  estTokens: number;
  estCostUsd: number;
  estSeconds: number;
} {
  const specialists = Math.max(1, draft.agentSlugs.length - 1);
  const providerCalls =
    draft.meetingType === 'individual'
      ? draft.rounds * 2 + 1
      : 1 + draft.rounds * specialists + 1;
  const estTokens = providerCalls * 650;
  return {
    providerCalls,
    estTokens,
    estCostUsd: 0,
    estSeconds: Math.round(providerCalls * 6),
  };
}
