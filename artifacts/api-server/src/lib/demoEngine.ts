import { db, runsTable, runEventsTable } from "@workspace/db";
import type { RunParticipantJson, RunRow, ScriptedEventJson } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

/**
 * Deterministic Demo Provider run engine.
 *
 * At launch the full meeting is scripted (deterministic, seeded on run title +
 * participants) with per-event time offsets. Events are lazily materialized
 * into the append-only run_events table whenever the run is read, based on the
 * effective elapsed time (excluding paused intervals). This mirrors the
 * upstream Virtual Lab speaking order:
 *   team:       R x (lead, members...) + final lead synthesis = R*(M+1)+1 calls
 *   individual: R x (expert, critic) + final expert revision  = 2*R+1 calls
 */

const ACTIVE_STATUSES = new Set(["queued", "validating", "running", "pause_pending"]);
const TURN_GAP_MS = 2600;
const TURN_DURATION_MS = 1400;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: T[], seed: number): T {
  // >>> 0 guards against negative values from signed 32-bit shifts upstream
  return arr[(seed >>> 0) % arr.length]!;
}

function turnText(
  p: RunParticipantJson,
  round: number,
  totalRounds: number,
  objective: string,
  questions: string[],
  isFinal: boolean,
  seed: number,
): string {
  const obj = objective || "the stated research agenda";
  if (isFinal) {
    return [
      `Synthesizing the discussion on ${obj}.`,
      ``,
      `Across ${totalRounds} round${totalRounds === 1 ? "" : "s"}, the team converged on a defensible position while preserving genuine disagreements. Direct evidence supports the core recommendation; extrapolations are labeled as inference rather than established fact.`,
      ``,
      questions.length > 0
        ? `Each required agenda question has been answered explicitly in the structured summary, with supporting rationale and remaining uncertainty noted per question.`
        : `The agenda objective has been addressed with explicit assumptions and remaining uncertainty noted.`,
      ``,
      `Recommended next steps are scoped to reduce decision-critical uncertainty first, each with an acceptance criterion. This synthesis is a simulated deliberation for demonstration and requires qualified human review before any consequential use.`,
    ].join("\n");
  }
  const openers = [
    `From the perspective of ${p.title.toLowerCase()}, the central consideration for ${obj} is methodological soundness before scale.`,
    `Examining ${obj} through my area of focus, the strongest available signal comes from converging but indirect lines of evidence.`,
    `On ${obj}: the framing is sound, but two assumptions deserve scrutiny before we commit to a direction.`,
    `My assessment of ${obj} in round ${round}: the proposed approach is feasible, provided constraints on data quality are enforced early.`,
  ];
  const middles = [
    `First, the current evidence base distinguishes association from mechanism only weakly; I recommend treating mechanistic claims as hypotheses. Second, a small pilot with predefined acceptance criteria would resolve the highest-variance unknown cheaply.`,
    `I want to flag a risk: without a pre-registered analysis plan, the comparison invites selective reporting. A blocked design with explicit controls addresses this at modest cost.`,
    `The literature offers partial precedent; effect sizes are heterogeneous and likely sensitive to protocol details. We should encode those details as explicit constraints rather than assumptions.`,
    `Quantitatively, the decision hinges on a parameter we can bound with a focused measurement rather than debate. I propose we specify that measurement precisely and defer downstream claims until it lands.`,
  ];
  const critic = [
    `As critic: several claims this round outran their evidence. Agreement among roles here must not be read as independent validation — the roles share one transcript and one underlying model. I ask the team to restate which conclusions rest on direct evidence versus inference.`,
    `Critical review: the plan is coherent, but the failure modes are underspecified. What observation would falsify the leading hypothesis? Until that is stated, confidence should remain qualified.`,
  ];
  const closers = [
    `I defer to the lead on prioritization, but recommend the pilot precede any broader commitment.`,
    `Summary of my position: proceed, with the stated constraint made explicit in the plan.`,
    `I remain unconvinced on one point and have flagged it for the synthesis so the disagreement is preserved.`,
    `This is consistent with what other roles have raised; the residual uncertainty is quantifiable and worth one focused round of work.`,
  ];
  if (p.roleType === "critic") {
    return `${pick(critic, seed)}\n\n${pick(closers, seed >>> 3)}`;
  }
  if (p.roleType === "lead" && round > 0) {
    return `Round ${round} framing: ${pick(openers, seed)}\n\n${pick(middles, seed >>> 2)}\n\nI ask each specialist to answer with respect to the required questions, and to separate evidence from inference explicitly.`;
  }
  return `${pick(openers, seed)}\n\n${pick(middles, seed >>> 2)}\n\n${pick(closers, seed >>> 4)}`;
}

function buildSummary(run: {
  title: string;
  agendaObjective: string | null;
  requiredQuestions: string[];
  participants: RunParticipantJson[];
  rounds: number;
}): Record<string, unknown> {
  const obj = run.agendaObjective || run.title;
  return {
    simulated: true,
    agenda: obj,
    executive_summary: `The ${run.participants.length}-role deliberation on "${obj}" converged on a conditionally favorable recommendation: proceed with a bounded pilot designed to resolve the highest-impact uncertainty before broader commitment. Direct evidence supports feasibility; mechanistic and generalization claims remain inference and are labeled as such. One substantive disagreement is preserved rather than smoothed over.`,
    recommendation:
      "Run a small, pre-registered pilot with explicit acceptance criteria targeting the decision-critical parameter identified in discussion; defer downstream claims until it completes.",
    contributions: run.participants.map((p) => ({
      role: p.title,
      role_type: p.roleType,
      contribution:
        p.roleType === "critic"
          ? "Challenged unsupported claims, insisted on falsifiability, and ensured agreement was not misread as independent validation."
          : p.roleType === "lead" || p.roleType === "expert"
            ? "Framed the agenda, integrated specialist input, reconciled disagreements, and produced the final synthesis."
            : `Contributed domain analysis from ${p.title.toLowerCase()} expertise, separating evidence from inference.`,
    })),
    answers_to_required_questions: run.requiredQuestions.map((q, i) => ({
      question: q,
      answer: `Addressed in rounds ${Math.min(i + 1, run.rounds)}–${run.rounds}: the team's position is stated with supporting rationale in the transcript; residual uncertainty is explicitly bounded rather than hidden.`,
    })),
    assumptions: [
      "Available evidence is representative of the deployment context.",
      "Protocol details flagged in discussion are enforceable as constraints.",
    ],
    disagreements: [
      {
        topic: "Strength of mechanistic claims",
        positions:
          "One specialist holds the mechanism is sufficiently supported to guide design; the critic maintains it should be treated as a hypothesis until directly measured.",
        resolution: "Unresolved — preserved for human decision.",
      },
    ],
    risks_and_limitations: [
      "Simulated deliberation: all roles are model-driven personas sharing one transcript, not independent human experts.",
      "Selective-reporting risk if the pilot is not pre-registered.",
      "Effect heterogeneity across protocols may limit generalization.",
    ],
    next_steps: [
      { step: "Specify the decision-critical measurement precisely", acceptance_criterion: "Written protocol with pre-registered analysis plan" },
      { step: "Execute bounded pilot", acceptance_criterion: "Primary endpoint measured with predefined threshold" },
      { step: "Reconvene follow-up meeting with pilot data attached as evidence", acceptance_criterion: "Structured comparison against this run's predictions" },
    ],
    confidence: {
      level: "moderate",
      rationale:
        "Feasibility is directly supported; the recommendation's value depends on an unmeasured parameter that the proposed pilot is designed to bound. Confidence is stated qualitatively because a numeric certainty would be uncalibrated.",
    },
  };
}

export function buildScript(run: {
  id?: string;
  title: string;
  kind: string;
  rounds: number;
  agendaObjective: string | null;
  requiredQuestions: string[];
  participants: RunParticipantJson[];
}): { script: ScriptedEventJson[]; plannedCallCount: number } {
  const seedBase = hash(run.title + run.participants.map((p) => p.agentId).join(","));
  const script: ScriptedEventJson[] = [];
  let t = 400;
  const push = (e: Omit<ScriptedEventJson, "offsetMs">, dt = 0) => {
    t += dt;
    script.push({ offsetMs: t, ...e });
  };

  push({ type: "run.validating" });
  push({ type: "run.started", payload: { simulation: true } }, 600);

  const rounds = Math.max(0, run.rounds);
  const objective = run.agendaObjective ?? run.title;

  // Speaking order per upstream semantics
  const speakers: { p: RunParticipantJson; round: number; isFinal: boolean }[] = [];
  if (run.kind === "individual") {
    const expert =
      run.participants.find((p) => p.roleType === "expert" || p.roleType === "lead") ?? run.participants[0]!;
    const critic = run.participants.find((p) => p.roleType === "critic");
    for (let r = 1; r <= rounds; r++) {
      speakers.push({ p: expert, round: r, isFinal: false });
      if (critic) speakers.push({ p: critic, round: r, isFinal: false });
    }
    speakers.push({ p: expert, round: rounds, isFinal: true });
  } else {
    const lead = run.participants.find((p) => p.roleType === "lead") ?? run.participants[0]!;
    const members = run.participants.filter((p) => p !== lead);
    for (let r = 1; r <= rounds; r++) {
      speakers.push({ p: lead, round: r, isFinal: false });
      for (const m of members) speakers.push({ p: m, round: r, isFinal: false });
    }
    speakers.push({ p: lead, round: rounds, isFinal: true });
  }

  let lastRound = 0;
  let call = 0;
  for (const s of speakers) {
    if (s.round !== lastRound && !s.isFinal) {
      push({ type: "round.started", round: s.round }, TURN_GAP_MS / 2);
      lastRound = s.round;
    }
    call += 1;
    const seed = seedBase + call * 7919;
    push(
      {
        type: "turn.started",
        round: s.round,
        agentId: s.p.agentId,
        agentTitle: s.p.title,
        roleType: s.p.roleType,
        payload: { call },
      },
      TURN_GAP_MS,
    );
    const content = turnText(s.p, s.round, rounds, objective, run.requiredQuestions, s.isFinal, seed);
    const tokens = 220 + (seed % 160);
    push(
      {
        type: "turn.completed",
        round: s.round,
        agentId: s.p.agentId,
        agentTitle: s.p.title,
        roleType: s.p.roleType,
        content,
        payload: { call, tokens, is_final: s.isFinal, simulation: true },
      },
      TURN_DURATION_MS,
    );
    if (!s.isFinal && call === Math.ceil(speakers.length / 2)) {
      push({ type: "checkpoint.reached", round: s.round, payload: { boundary: "mid-meeting" } }, 300);
    }
  }

  push({ type: "summary.completed", payload: { schema: "meeting_summary.v1", simulation: true } }, TURN_GAP_MS);
  push({ type: "run.completed" }, 500);

  return { script, plannedCallCount: speakers.length };
}

export function summaryFor(run: RunRow): Record<string, unknown> {
  return buildSummary({
    title: run.title,
    agendaObjective: run.agendaObjective,
    requiredQuestions: run.requiredQuestions,
    participants: run.participants,
    rounds: run.rounds,
  });
}

function effectiveElapsedMs(run: RunRow, now: Date): number {
  if (!run.startedAt) return 0;
  let elapsed = now.getTime() - run.startedAt.getTime() - run.pausedMsTotal;
  if (run.pausedAt) elapsed -= now.getTime() - run.pausedAt.getTime();
  return Math.max(0, elapsed);
}

async function nextSeq(runId: string): Promise<number> {
  const rows = await db
    .select({ seq: runEventsTable.seq })
    .from(runEventsTable)
    .where(eq(runEventsTable.runId, runId));
  return rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
}

export async function appendEvent(
  runId: string,
  e: Omit<ScriptedEventJson, "offsetMs">,
): Promise<void> {
  const seq = await nextSeq(runId);
  await db.insert(runEventsTable).values({
    runId,
    seq,
    type: e.type,
    round: e.round ?? null,
    agentId: e.agentId ?? null,
    agentTitle: e.agentTitle ?? null,
    roleType: e.roleType ?? null,
    content: e.content ?? null,
    payload: e.payload ?? null,
  });
}

/** Materialize due scripted events. Returns the fresh run row. */
export async function materializeRun(runId: string): Promise<RunRow | null> {
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  if (!run) return null;
  if (!ACTIVE_STATUSES.has(run.status) || run.status === "paused") return run;
  if (run.status === "queued") {
    // start immediately (demo worker claims instantly)
    const startedAt = run.startedAt ?? new Date();
    await db
      .update(runsTable)
      .set({ status: "running", startedAt })
      .where(eq(runsTable.id, runId));
    run.status = "running";
    run.startedAt = startedAt;
    await appendEvent(runId, { type: "run.queued" });
  }

  const now = new Date();
  const elapsed = effectiveElapsedMs(run, now);
  const due = run.script.filter(
    (e: ScriptedEventJson, i: number) => i >= run.scriptCursor && e.offsetMs <= elapsed,
  );
  if (due.length === 0) return run;

  let seq = await nextSeq(runId);
  let { callCount, tokensUsed, currentRound } = run;
  let currentSpeaker = run.currentSpeaker;
  let status = run.status;
  let summary = run.summary ?? null;
  let completedAt = run.completedAt;

  for (const e of due) {
    await db.insert(runEventsTable).values({
      runId,
      seq: seq++,
      type: e.type,
      round: e.round ?? null,
      agentId: e.agentId ?? null,
      agentTitle: e.agentTitle ?? null,
      roleType: e.roleType ?? null,
      content: e.content ?? null,
      payload: e.payload ?? null,
    });
    if (e.type === "round.started" && e.round) currentRound = e.round;
    if (e.type === "turn.started") currentSpeaker = e.agentTitle ?? null;
    if (e.type === "turn.completed") {
      callCount += 1;
      const tk = e.payload && typeof e.payload["tokens"] === "number" ? (e.payload["tokens"] as number) : 0;
      tokensUsed += tk;
      currentSpeaker = null;
    }
    if (e.type === "summary.completed") summary = summaryFor(run);
    if (e.type === "run.completed") {
      status = "completed";
      completedAt = now;
      currentSpeaker = null;
    }
  }

  await db
    .update(runsTable)
    .set({
      scriptCursor: run.scriptCursor + due.length,
      callCount,
      tokensUsed,
      currentRound,
      currentSpeaker,
      status,
      summary,
      completedAt,
      estimatedCost: 0,
    })
    .where(eq(runsTable.id, runId));

  const [fresh] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  return fresh ?? null;
}

export async function listEvents(runId: string) {
  return db
    .select()
    .from(runEventsTable)
    .where(eq(runEventsTable.runId, runId))
    .orderBy(asc(runEventsTable.seq));
}
