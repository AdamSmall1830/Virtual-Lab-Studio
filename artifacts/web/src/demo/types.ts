// Virtual Lab Studio — demo data layer types.
// All AI content in this build comes from the deterministic Demo Provider
// and is ALWAYS labeled as simulation in the UI.

export type MeetingType = 'team' | 'individual' | 'ensemble';

export interface AgentDefinition {
  slug: string;
  title: string;
  category: string;
  icon: string;
  accent: string;
  description: string;
  expertise: string;
  goal: string;
  role: string;
  default_role_type: 'lead' | 'member' | 'critic' | 'merge_chair' | string;
  default_tools: string[];
  behavioral_rules: string[];
  recommended_temperature: number;
  /** Immutable version history; version 1 is the seeded definition. */
  version: number;
  archived?: boolean;
  createdAt: string;
}

export interface MeetingTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  meeting_type: MeetingType | string;
  suggested_agents: {
    agent_slug: string;
    role_type: string;
    required: boolean;
  }[];
  default_rounds?: number;
  agenda_scaffold?: {
    agenda?: string;
    questions?: string[];
    rules?: string[];
    desired_output?: string;
  };
  [key: string]: unknown;
}

export interface EvidenceItem {
  evidence_id: string;
  source_type: string;
  title: string;
  citation: string | null;
  content: string;
  trusted_metadata?: { author?: string; created_at?: string };
  projectId: string;
  sha256?: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  discipline: string;
  research_question: string;
  hypotheses: string[];
  objectives: string[];
  constraints: string[];
  human_decision_supported: string;
  disclosures: string[];
  tags: string[];
  createdAt: string;
}

export interface MeetingBudgets {
  max_provider_calls: number;
  max_tool_calls: number;
  max_wall_seconds: number;
  max_cost_usd: number;
}

export interface MeetingDraft {
  id: string;
  projectId: string;
  templateSlug: string | null;
  title: string;
  meetingType: MeetingType;
  agenda: string;
  questions: string[];
  rules: string[];
  desiredOutput: string;
  humanDecision: string;
  agentSlugs: string[];
  leadSlug: string | null;
  criticSlug: string | null;
  rounds: number;
  temperature: number;
  provider: 'demo';
  model: string;
  evidenceIds: string[];
  pauseAfterRound: boolean;
  budgets: MeetingBudgets;
  updatedAt: string;
  revision: number;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'pause_pending'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ToolCallRecord {
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
  label: string;
  latencyMs: number;
}

export interface RunTurn {
  index: number;
  round: number;
  speaker: string;
  agentSlug: string | null;
  stage: 'discussion' | 'final' | string;
  content: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  toolCalls: ToolCallRecord[];
  citedEvidenceIds: string[];
  startedAt: string;
  completedAt: string | null;
}

export interface Intervention {
  id: string;
  atTurnIndex: number;
  round: number;
  author: string;
  content: string;
  createdAt: string;
}

export interface RunEvent {
  seq: number;
  type:
    | 'run_started'
    | 'round_started'
    | 'turn_started'
    | 'turn_delta'
    | 'tool_call'
    | 'turn_completed'
    | 'round_completed'
    | 'checkpoint'
    | 'pause_pending'
    | 'paused'
    | 'resumed'
    | 'intervention'
    | 'summary_ready'
    | 'run_completed'
    | 'run_cancelled'
    | 'run_failed';
  at: string;
  data: Record<string, unknown>;
}

export interface RunUsage {
  providerCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  wallSeconds: number;
}

export interface HumanReview {
  id: string;
  runId: string;
  rubric: string;
  scores: { criterion: string; score: number }[];
  rationale: string;
  reviewer: string;
  createdAt: string;
}

export interface StructuredSummary {
  agenda: string;
  executive_summary: string;
  role_contributions: {
    agent_id: string;
    agent_title: string;
    contribution: string;
    evidence_ids: string[];
  }[];
  recommendation: {
    decision: string;
    rationale: string;
    conditions: string[];
  };
  [key: string]: unknown;
}

export interface Run {
  id: string;
  projectId: string;
  title: string;
  meetingType: MeetingType;
  status: RunStatus;
  /** Frozen copy of the meeting definition at launch. Immutable. */
  frozenDefinition: MeetingDraft;
  /** Immutable snapshots of the exact agent definitions (with versions) at launch. */
  frozenAgents: AgentDefinition[];
  /** Immutable snapshots of the evidence items selected at launch. */
  frozenEvidence: EvidenceItem[];
  provider: 'demo';
  model: string;
  simulated: true;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  currentRound: number;
  currentStage: string;
  activeSpeaker: string | null;
  turns: RunTurn[];
  events: RunEvent[];
  interventions: Intervention[];
  usage: RunUsage;
  summary: StructuredSummary | null;
  failure: { message: string; correlationId: string } | null;
}

export interface NotebookEntry {
  id: string;
  projectId: string;
  kind: 'note' | 'ai_draft' | 'decision' | 'task' | 'question';
  title: string;
  content: string;
  accepted?: boolean;
  links: { runId?: string; turnIndex?: number; evidenceId?: string }[];
  history: { at: string; content: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface Comparison {
  id: string;
  projectId: string;
  runIds: string[];
  blinded: boolean;
  rubricScores: Record<string, { criterion: string; score: number }[]>;
  preferredRunId: string | null;
  rationale: string;
  createdAt: string;
}

export interface WorkspaceState {
  schemaVersion: number;
  workspaceName: string;
  theme: 'dark' | 'light';
  onboarded: boolean;
  provider: 'demo';
  projects: Project[];
  agents: AgentDefinition[];
  agentVersions: Record<string, AgentDefinition[]>;
  templates: MeetingTemplate[];
  evidence: EvidenceItem[];
  drafts: MeetingDraft[];
  runs: Run[];
  notebook: NotebookEntry[];
  reviews: HumanReview[];
  comparisons: Comparison[];
}
