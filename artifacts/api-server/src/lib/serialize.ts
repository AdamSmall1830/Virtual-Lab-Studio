import type { AgentRow, ProjectRow, RunEventRow, RunRow, TemplateRow } from "@workspace/db";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function serializeProject(p: ProjectRow, runCount = 0) {
  return {
    id: p.id,
    name: p.name,
    abstract: p.abstract,
    domain: p.domain,
    tags: p.tags,
    status: p.status,
    researchQuestion: p.researchQuestion,
    hypotheses: p.hypotheses,
    objectives: p.objectives,
    constraints: p.constraints,
    ethicsNotes: p.ethicsNotes,
    disclosureNotes: p.disclosureNotes,
    humanDecision: p.humanDecision,
    runCount,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function serializeAgent(a: AgentRow) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    shortLabel: a.shortLabel,
    expertise: a.expertise,
    goal: a.goal,
    role: a.role,
    advancedInstructions: a.advancedInstructions,
    limitations: a.limitations,
    provider: a.provider,
    model: a.model,
    temperature: a.temperature,
    accentColor: a.accentColor,
    version: a.version,
    archived: a.archived,
    isSystem: a.isSystem,
    createdAt: a.createdAt.toISOString(),
  };
}

export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    kind: t.kind,
    category: t.category,
    description: t.description,
    objective: t.objective,
    requiredQuestions: t.requiredQuestions,
    rules: t.rules,
    suggestedAgentSlugs: t.suggestedAgentSlugs,
    defaultRounds: t.defaultRounds,
    intendedOutput: t.intendedOutput,
    version: t.version,
  };
}

export function serializeRun(r: RunRow, projectName: string | null = null) {
  return {
    id: r.id,
    projectId: r.projectId,
    projectName,
    templateId: r.templateId,
    title: r.title,
    kind: r.kind,
    status: r.status,
    agendaObjective: r.agendaObjective,
    requiredQuestions: r.requiredQuestions,
    rules: r.rules,
    rounds: r.rounds,
    currentRound: r.currentRound,
    currentSpeaker: r.currentSpeaker,
    participants: r.participants,
    isSimulation: r.isSimulation,
    callCount: r.callCount,
    plannedCallCount: r.plannedCallCount,
    tokensUsed: r.tokensUsed,
    estimatedCost: r.estimatedCost,
    summary: r.summary ?? null,
    failureReason: r.failureReason,
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

export function serializeRunEvent(e: RunEventRow) {
  return {
    id: e.id,
    runId: e.runId,
    seq: e.seq,
    type: e.type,
    round: e.round,
    agentId: e.agentId,
    agentTitle: e.agentTitle,
    roleType: e.roleType,
    content: e.content,
    payload: e.payload ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}
