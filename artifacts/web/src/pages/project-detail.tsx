import React, { useState } from 'react';
import { useRoute, useLocation, Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useProject,
  useProjectRuns,
  useProjectEvidence,
  useProjectComparisons,
  useCreateProject,
  getProjectRunsQueryKey,
  getProjectEvidenceQueryKey,
  getProjectComparisonsQueryKey,
  getGetProjectApiV1ProjectsProjectIdGetQueryKey,
  getProjectsQueryKey,
} from '@/api';
import type { RunOut, EvidenceSourceOut, ComparisonSetOut, ProjectCreateIn } from '@/api';
import { useSession } from '@/api/session';
import ProjectCompare from './project-compare';
import {
  ArrowLeft,
  FileText,
  Activity,
  Database,
  GitMerge,
  Play,
  Loader2,
  AlertTriangle,
  Save,
  ChevronRight,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';

const RUNNING_STATUSES = new Set(['queued', 'leased', 'running', 'pausing', 'paused', 'cancelling']);

function runDotClass(status: string): string {
  if (status === 'completed') return 'bg-accent';
  if (RUNNING_STATUSES.has(status)) return status === 'running' ? 'bg-primary animate-pulse' : 'bg-primary';
  if (status === 'failed') return 'bg-destructive';
  if (status === 'cancelled' || status === 'budget_stopped') return 'bg-warning';
  return 'bg-muted-foreground';
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

const inputClass =
  'w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50';

/* Real project creation form for the /app/projects/new route. */
function NewProjectForm() {
  const { workspaceId } = useSession();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();

  const [form, setForm] = useState({
    name: '',
    discipline: '',
    description: '',
    research_question: '',
    human_decision_supported: '',
    hypotheses: '',
    objectives: '',
    tags: '',
  });

  const nameValid = form.name.trim().length > 0;
  const errorMessage =
    createProject.isError
      ? (createProject.error instanceof Error ? createProject.error.message : 'Failed to create project. Please try again.')
      : null;

  const toLines = (value: string) => value.split('\n').map((v) => v.trim()).filter(Boolean);
  const toTags = (value: string) =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  const handleCreate = () => {
    if (!nameValid || !workspaceId) return;
    const data: ProjectCreateIn = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      discipline: form.discipline.trim() || undefined,
      research_question: form.research_question.trim() || undefined,
      human_decision_supported: form.human_decision_supported.trim() || undefined,
      hypotheses: toLines(form.hypotheses),
      objectives: toLines(form.objectives),
      tags: toTags(form.tags),
    };
    createProject.mutate(
      { workspaceId, data },
      {
        onSuccess: async (project) => {
          await queryClient.invalidateQueries({ queryKey: getProjectsQueryKey(workspaceId) });
          setLocation(`/app/projects/${project.id}`);
        },
      },
    );
  };

  const disabled = !nameValid || !workspaceId || createProject.isPending;

  return (
    <div className="animate-in fade-in duration-300 max-w-3xl mx-auto pb-12">
      <header className="mb-6">
        <Link href="/app/projects" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Projects
        </Link>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-3xl font-display font-bold">New Project</h1>
          <button
            onClick={handleCreate}
            disabled={disabled}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {createProject.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Create Project
          </button>
        </div>
      </header>

      {errorMessage && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>{errorMessage}</p>
        </div>
      )}

      <div className="space-y-6">
        <div className="vls-reading-surface rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-display font-semibold mb-4">Basics</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Project Name <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="E.g. Biodegradable Packaging Pilot"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Discipline</label>
              <input
                type="text"
                className={inputClass}
                value={form.discipline}
                onChange={(e) => setForm({ ...form, discipline: e.target.value })}
                placeholder="E.g. Materials Science"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Abstract / Description</label>
            <textarea
              className={`${inputClass} min-h-[80px]`}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Tags (comma separated)</label>
            <input
              type="text"
              className={inputClass}
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="sustainability, packaging, pilot"
            />
          </div>
        </div>

        <div className="vls-reading-surface rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-display font-semibold mb-4">Research Framing</h2>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Primary Research Question</label>
            <input
              type="text"
              className={inputClass}
              value={form.research_question}
              onChange={(e) => setForm({ ...form, research_question: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Objectives (one per line)</label>
              <textarea
                className={`${inputClass} min-h-[120px]`}
                value={form.objectives}
                onChange={(e) => setForm({ ...form, objectives: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Hypotheses (one per line)</label>
              <textarea
                className={`${inputClass} min-h-[120px]`}
                value={form.hypotheses}
                onChange={(e) => setForm({ ...form, hypotheses: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2 pt-2">
            <label className="text-sm font-medium text-foreground">Human Decision Supported</label>
            <textarea
              className={`${inputClass} min-h-[80px]`}
              value={form.human_decision_supported}
              onChange={(e) => setForm({ ...form, human_decision_supported: e.target.value })}
              placeholder="What actual decision will a human make based on this project's outputs?"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={handleCreate}
            disabled={disabled}
            className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createProject.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}

function CenteredMessage({ icon: Icon, title, children }: { icon: typeof AlertTriangle; title: string; children?: React.ReactNode }) {
  return (
    <div className="text-center py-16 border border-dashed rounded-xl bg-background/30">
      <Icon className="w-10 h-10 text-muted-foreground mx-auto mb-4 opacity-50" />
      <h3 className="font-medium text-lg mb-2">{title}</h3>
      {children && <div className="text-muted-foreground text-sm max-w-sm mx-auto">{children}</div>}
    </div>
  );
}

export default function ProjectDetail() {
  const [matchNew] = useRoute('/app/projects/new');
  if (matchNew) {
    return <NewProjectForm />;
  }
  return <ProjectDetailView />;
}

function ProjectDetailView() {
  const [, params] = useRoute('/app/projects/:projectId/:tab?');

  const projectId = params?.projectId ?? '';
  const tab = params?.tab || 'overview';

  const enabled = Boolean(projectId);
  const projectQuery = useProject(projectId, {
    query: { enabled, queryKey: getGetProjectApiV1ProjectsProjectIdGetQueryKey(projectId) },
  });
  const project = projectQuery.data;

  const runsQuery = useProjectRuns(projectId, {
    query: { enabled, queryKey: getProjectRunsQueryKey(projectId) },
  });
  const evidenceQuery = useProjectEvidence(projectId, {
    query: { enabled, queryKey: getProjectEvidenceQueryKey(projectId) },
  });
  const comparisonsQuery = useProjectComparisons(projectId, {
    query: { enabled, queryKey: getProjectComparisonsQueryKey(projectId) },
  });

  const runs: RunOut[] = runsQuery.data ?? [];
  const evidence: EvidenceSourceOut[] = evidenceQuery.data ?? [];
  const comparisons: ComparisonSetOut[] = comparisonsQuery.data ?? [];

  if (projectQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-primary" aria-label="Loading project" />
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="max-w-3xl mx-auto pt-12 text-center">
        <AlertTriangle className="w-10 h-10 text-destructive mx-auto mb-4" />
        <h1 className="text-xl font-display font-semibold mb-2">Project not found</h1>
        <p className="text-muted-foreground text-sm mb-6">We couldn't load this project.</p>
        <Link href="/app/projects" className="text-primary hover:underline text-sm">
          Back to Projects
        </Link>
      </div>
    );
  }

  const tabs = [
    { id: 'overview', label: 'Overview', icon: FileText },
    { id: 'meetings', label: 'Runs', icon: Activity, count: runs.length },
    { id: 'evidence', label: 'Evidence', icon: Database, count: evidence.length },
    { id: 'compare', label: 'Compare', icon: GitMerge, count: comparisons.length },
  ];

  const tags = Array.isArray(project.tags) ? project.tags : [];

  return (
    <div className="animate-in fade-in duration-300 max-w-5xl mx-auto h-full flex flex-col pb-12">
      <header className="mb-6">
        <Link href="/app/projects" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Projects
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {project.discipline && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wider">
                  {project.discipline}
                </span>
              )}
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-secondary/10 text-secondary capitalize">
                {project.status}
              </span>
            </div>
            <h1 className="text-3xl font-display font-bold">{project.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Created {format(new Date(project.created_at), 'MMM d, yyyy')}
            </p>
          </div>
          <Link
            href={`/app/meetings/new?project=${project.id}`}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2 shrink-0"
          >
            <Play className="w-4 h-4" /> New Meeting
          </Link>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-border mb-6 overflow-x-auto pb-px">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={`/app/projects/${project.id}/${t.id}`}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.count !== undefined && (
              <span className="ml-1.5 bg-background text-muted-foreground px-1.5 py-0.5 rounded text-xs border border-border">
                {t.count}
              </span>
            )}
          </Link>
        ))}
      </div>

      <div className="flex-1">
        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-display font-semibold">Research Framing</h2>
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
                  Primary Research Question
                </div>
                <p className="text-sm">{project.research_question || 'Not specified.'}</p>
              </div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
                  Description
                </div>
                <p className="text-sm whitespace-pre-wrap">{project.description || 'No description provided.'}</p>
              </div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
                  Human Decision Supported
                </div>
                <p className="text-sm">{project.human_decision_supported || 'Not specified.'}</p>
              </div>
              {tags.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Tags</div>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag, i) => (
                      <span key={i} className="text-xs bg-background border border-border px-2 py-0.5 rounded">
                        {String(tag)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'meetings' && (
          <div className="space-y-4">
            {runsQuery.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
                ))}
              </div>
            ) : runsQuery.isError ? (
              <CenteredMessage icon={AlertTriangle} title="Couldn't load runs" />
            ) : runs.length === 0 ? (
              <CenteredMessage icon={Activity} title="No runs in this project">
                Start a new meeting to debate hypotheses, review literature, or design experiments.
              </CenteredMessage>
            ) : (
              <div className="vls-reading-surface rounded-xl divide-y divide-border overflow-hidden">
                {runs.map((run) => {
                  const live = RUNNING_STATUSES.has(run.status);
                  return (
                    <Link
                      key={run.id}
                      href={live ? `/app/runs/${run.id}/live` : `/app/runs/${run.id}`}
                      className="flex items-center p-4 hover:bg-background/50 transition-colors group gap-4"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`w-2 h-2 rounded-full ${runDotClass(run.status)}`} />
                          <span className="font-medium group-hover:text-primary transition-colors truncate">
                            Run {shortId(run.id)}
                          </span>
                        </div>
                        <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
                          <span className="capitalize">{run.status.replace(/_/g, ' ')}</span>
                          <span>•</span>
                          <span>{formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}</span>
                          {run.wall_seconds > 0 && (
                            <>
                              <span>•</span>
                              <span>{Math.round(run.wall_seconds)}s</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="hidden sm:flex text-sm text-muted-foreground items-center gap-6">
                        <div className="text-right">
                          <div className="font-medium text-foreground">{run.provider_call_count}</div>
                          <div className="text-xs">Calls</div>
                        </div>
                        <div className="text-right">
                          <div className="font-medium text-foreground">${run.actual_cost_usd.toFixed(2)}</div>
                          <div className="text-xs">Cost</div>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'evidence' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="font-display font-semibold text-lg">Evidence Sources</h2>
              <Link href="/app/evidence" className="text-sm text-primary hover:underline">
                Open Evidence Library
              </Link>
            </div>
            {evidenceQuery.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
                ))}
              </div>
            ) : evidenceQuery.isError ? (
              <CenteredMessage icon={AlertTriangle} title="Couldn't load evidence" />
            ) : evidence.length === 0 ? (
              <CenteredMessage icon={Database} title="No evidence yet">
                Upload sources or import references from the Evidence Library.
              </CenteredMessage>
            ) : (
              <div className="vls-reading-surface rounded-xl divide-y divide-border overflow-hidden">
                {evidence.map((e) => (
                  <Link
                    key={e.id}
                    href="/app/evidence"
                    className="flex items-center p-4 hover:bg-background/50 transition-colors group gap-4"
                  >
                    <Database className="w-4 h-4 text-accent shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium group-hover:text-primary transition-colors truncate">{e.title}</div>
                      <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                        <span className="capitalize">{e.source_type.replace(/_/g, ' ')}</span>
                        <span>•</span>
                        <span className="capitalize">{e.processing_status}</span>
                        {e.citation && (
                          <>
                            <span>•</span>
                            <span className="truncate">{e.citation}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'compare' && <ProjectCompare />}
      </div>
    </div>
  );
}
