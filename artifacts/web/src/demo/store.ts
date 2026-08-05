// Virtual Lab Studio — demo workspace store.
// A deterministic, localStorage-persisted data layer that stands in for the
// backend API. All AI output originates from the deterministic Demo Provider
// and is always labeled as simulation.

import seedAgentsRaw from './data/seed_agents.json';
import seedTemplatesRaw from './data/seed_meeting_templates.json';
import sampleProjectRaw from './data/sample_project_import.json';
import type {
  AgentDefinition,
  Comparison,
  EvidenceItem,
  HumanReview,
  MeetingDraft,
  MeetingTemplate,
  NotebookEntry,
  Project,
  Run,
  WorkspaceState,
} from './types';

const STORAGE_KEY = 'vls-workspace-v1';
const SCHEMA_VERSION = 4;

type Listener = () => void;
const listeners = new Set<Listener>();

let state: WorkspaceState | null = null;

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedState(): WorkspaceState {
  const createdAt = nowIso();
  const agents: AgentDefinition[] = (
    seedAgentsRaw as { agents: Omit<AgentDefinition, 'version' | 'createdAt'>[] }
  ).agents.map((a) => ({ ...a, version: 1, createdAt }));

  const templates = (seedTemplatesRaw as { templates: MeetingTemplate[] })
    .templates;

  const sample = sampleProjectRaw as {
    project: Omit<Project, 'id' | 'createdAt'>;
    evidence: Omit<EvidenceItem, 'projectId'>[];
    meeting_draft: {
      template_slug: string;
      title: string;
      selected_agent_slugs: string[];
      rounds: number;
      temperature: number;
      evidence_ids: string[];
      provider: string;
      model: string;
      budgets: Record<string, number>;
    };
  };

  const projectId = 'proj_demo_packaging';
  const project: Project = { ...sample.project, id: projectId, createdAt };

  const evidence: EvidenceItem[] = sample.evidence.map((e) => ({
    ...e,
    projectId,
  }));

  const md = sample.meeting_draft;
  const draft: MeetingDraft = {
    id: 'draft_demo_seed',
    projectId,
    templateSlug: md.template_slug,
    title: md.title,
    meetingType: 'team',
    agenda: project.research_question,
    questions: [
      'Which formulation matrix and factors should the first pilot include?',
      'What are the primary and secondary response variables?',
      'What controls, replication, and randomization are required?',
      'What criteria advance a candidate to confirmatory testing?',
    ],
    rules: project.constraints,
    desiredOutput:
      'A staged pilot design with explicit factors, controls, replication, analysis plan, and advancement gates.',
    humanDecision: project.human_decision_supported,
    agentSlugs: md.selected_agent_slugs,
    leadSlug: 'principal-investigator',
    criticSlug: 'scientific-critic',
    rounds: md.rounds,
    temperature: md.temperature,
    provider: 'demo',
    model: md.model,
    evidenceIds: md.evidence_ids,
    pauseAfterRound: false,
    budgets: {
      max_provider_calls: md.budgets.max_provider_calls ?? 25,
      max_tool_calls: md.budgets.max_tool_calls ?? 10,
      max_wall_seconds: md.budgets.max_wall_seconds ?? 900,
      max_cost_usd: md.budgets.max_cost_usd ?? 0,
    },
    updatedAt: createdAt,
    revision: 1,
  };

  const agentVersions: Record<string, AgentDefinition[]> = {};
  for (const a of agents) agentVersions[a.slug] = [{ ...a }];

  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceName: 'Demo Research Workspace',
    theme: 'dark',
    onboarded: false,
    provider: 'demo',
    projects: [project],
    agents,
    agentVersions,
    templates,
    evidence,
    drafts: [draft],
    runs: [],
    notebook: [
      {
        id: 'nb_seed_1',
        projectId,
        kind: 'question',
        title: 'Baseline variability unknown',
        content:
          'We have not yet measured instrument repeatability or uncoated-film baseline variability. Any numeric thresholds must remain provisional until this is done.',
        links: [],
        history: [],
        createdAt,
        updatedAt: createdAt,
      },
    ],
    reviews: [],
    comparisons: [],
  };
}

function load(): WorkspaceState {
  if (state) return state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceState;
      if (parsed.schemaVersion === SCHEMA_VERSION) {
        // Terminally fail any run that was live when the page was unloaded:
        // the in-memory engine and its timers cannot be recovered.
        for (const run of parsed.runs) {
          if (
            ['queued', 'running', 'pause_pending', 'paused'].includes(
              run.status,
            )
          ) {
            run.status = 'failed';
            run.completedAt = run.completedAt ?? new Date().toISOString();
            run.currentStage = 'stopped';
            run.activeSpeaker = null;
            run.failure = {
              message:
                'Run interrupted: the page was reloaded while the simulated meeting was streaming. Launch a new run to continue.',
              correlationId: uid('corr'),
            };
            run.events.push({
              seq: run.events.length,
              type: 'run_failed',
              at: new Date().toISOString(),
              data: { reason: 'interrupted_by_reload' },
            });
          }
        }
        state = parsed;
        persist();
        return state;
      }
    }
  } catch {
    // fall through to reseed
  }
  state = seedState();
  persist();
  return state;
}

function persist(): void {
  if (!state) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full or unavailable — in-memory state still works
  }
}

export function getState(): WorkspaceState {
  return load();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function mutate(fn: (s: WorkspaceState) => void): void {
  const s = load();
  fn(s);
  persist();
  listeners.forEach((l) => l());
}

export function resetWorkspace(): void {
  state = seedState();
  persist();
  listeners.forEach((l) => l());
}

// ---- convenience accessors -------------------------------------------------

export function getProject(id: string): Project | undefined {
  return getState().projects.find((p) => p.id === id || p.slug === id);
}

export function getRun(id: string): Run | undefined {
  return getState().runs.find((r) => r.id === id);
}

export function getDraft(id: string): MeetingDraft | undefined {
  return getState().drafts.find((d) => d.id === id);
}

export function getAgent(slug: string): AgentDefinition | undefined {
  return getState().agents.find((a) => a.slug === slug);
}

export function projectEvidence(projectId: string): EvidenceItem[] {
  return getState().evidence.filter((e) => e.projectId === projectId);
}

export function projectRuns(projectId: string): Run[] {
  return getState().runs.filter((r) => r.projectId === projectId);
}

export function addReview(review: HumanReview): void {
  mutate((s) => {
    s.reviews.push(review);
  });
}

export function addNotebookEntry(entry: NotebookEntry): void {
  mutate((s) => {
    s.notebook.push(entry);
  });
}

export function addComparison(cmp: Comparison): void {
  mutate((s) => {
    s.comparisons.push(cmp);
  });
}
