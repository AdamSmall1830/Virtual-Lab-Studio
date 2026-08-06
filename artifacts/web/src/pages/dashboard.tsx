import React, { useMemo } from 'react';
import { Link } from 'wouter';
import { useQueries } from '@tanstack/react-query';
import {
  useProjects,
  useAgents,
  useTemplates,
  listRunsApiV1ProjectsProjectIdRunsGet,
  getProjectRunsQueryKey,
  getProjectsQueryKey,
  getListAgentsApiV1WorkspacesWorkspaceIdAgentsGetQueryKey,
  getListTemplatesApiV1WorkspacesWorkspaceIdTemplatesGetQueryKey,
} from '@/api';
import type { ProjectOut, RunOut } from '@/api';
import { useSession } from '@/api/session';
import {
  FolderOpen,
  Activity,
  Bot,
  LayoutTemplate,
  Play,
  ChevronRight,
  Clock,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

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

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
  loading,
}: {
  icon: typeof FolderOpen;
  label: string;
  value: number;
  tone: string;
  loading: boolean;
}) {
  return (
    <div className="vls-glass p-5 rounded-xl">
      <div className={`flex items-center gap-3 mb-4 ${tone}`}>
        <Icon className="w-5 h-5" />
        <h2 className="font-semibold font-display">{label}</h2>
      </div>
      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      ) : (
        <div className="text-3xl font-bold font-display">{value}</div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { workspaceId, workspace } = useSession();
  const enabled = Boolean(workspaceId);

  const wsId = workspaceId ?? '';
  const projectsQuery = useProjects(wsId, {
    query: { enabled, queryKey: getProjectsQueryKey(wsId) },
  });
  const agentsQuery = useAgents(wsId, {
    query: { enabled, queryKey: getListAgentsApiV1WorkspacesWorkspaceIdAgentsGetQueryKey(wsId) },
  });
  const templatesQuery = useTemplates(wsId, {
    query: { enabled, queryKey: getListTemplatesApiV1WorkspacesWorkspaceIdTemplatesGetQueryKey(wsId) },
  });

  const projects = projectsQuery.data ?? [];

  const runQueries = useQueries({
    queries: projects.map((p: ProjectOut) => ({
      queryKey: getProjectRunsQueryKey(p.id),
      queryFn: () => listRunsApiV1ProjectsProjectIdRunsGet(p.id),
      enabled: enabled && Boolean(p.id),
    })),
  });

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    projects.forEach((p) => map.set(p.id, p.name));
    return map;
  }, [projects]);

  const runsLoading = runQueries.some((q) => q.isLoading);
  const allRuns: RunOut[] = useMemo(
    () => runQueries.flatMap((q) => q.data ?? []),
    [runQueries],
  );

  const recentRuns = useMemo(
    () =>
      [...allRuns]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6),
    [allRuns],
  );

  const recentProjects = useMemo(
    () =>
      [...projects]
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 4),
    [projects],
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Welcome back{workspace ? ` to ${workspace.name}` : ''}
          </p>
        </div>
        <Link
          href="/app/meetings/new"
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2"
        >
          <Play className="w-4 h-4" />
          New Meeting
        </Link>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={FolderOpen} label="Projects" tone="text-primary" value={projects.length} loading={projectsQuery.isLoading} />
        <StatCard icon={Activity} label="Total Runs" tone="text-secondary" value={allRuns.length} loading={runsLoading || projectsQuery.isLoading} />
        <StatCard icon={Bot} label="Agents" tone="text-accent" value={agentsQuery.data?.length ?? 0} loading={agentsQuery.isLoading} />
        <StatCard icon={LayoutTemplate} label="Templates" tone="text-primary" value={templatesQuery.data?.length ?? 0} loading={templatesQuery.isLoading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="vls-reading-surface rounded-xl border border-border p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-display font-semibold">Recent Runs</h2>
              <Link href="/app/runs" className="text-sm text-primary hover:underline">View all</Link>
            </div>

            {projectsQuery.isError ? (
              <div className="text-center py-10 text-sm text-muted-foreground flex flex-col items-center gap-2">
                <AlertTriangle className="w-6 h-6 text-destructive" />
                Couldn't load runs.
              </div>
            ) : runsLoading || projectsQuery.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-14 rounded-lg bg-muted/50 animate-pulse" />
                ))}
              </div>
            ) : recentRuns.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-lg bg-background/50">
                <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-50" />
                <h3 className="font-medium mb-1">No runs yet</h3>
                <p className="text-sm text-muted-foreground mb-4">Start a multi-agent meeting to see it here.</p>
                <Link
                  href="/app/meetings/new"
                  className="inline-flex items-center gap-2 text-sm font-medium bg-primary/10 text-primary px-4 py-2 rounded-lg hover:bg-primary/20 transition-colors"
                >
                  <Play className="w-4 h-4" /> Start from Template
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {recentRuns.map((run) => (
                  <Link
                    key={run.id}
                    href={`/app/runs/${run.id}`}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-background/80 transition-colors group border border-transparent hover:border-border"
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${runDotClass(run.status)}`} />
                      <div>
                        <div className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                          {projectNameById.get(run.project_id) ?? `Run ${shortId(run.id)}`}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span className="capitalize">{run.status.replace(/_/g, ' ')}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}
                          </span>
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="vls-reading-surface rounded-xl border border-border p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-display font-semibold">Recent Projects</h2>
              <Link href="/app/projects" className="text-sm text-primary hover:underline">View all</Link>
            </div>

            {projectsQuery.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
                ))}
              </div>
            ) : projectsQuery.isError ? (
              <div className="text-center py-8 text-sm text-muted-foreground">Couldn't load projects.</div>
            ) : recentProjects.length === 0 ? (
              <div className="text-center py-8">
                <FolderOpen className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-50" />
                <p className="text-sm text-muted-foreground">No projects yet. Projects are provisioned server-side.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {recentProjects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/app/projects/${project.id}`}
                    className="block p-3 rounded-lg hover:bg-background/80 transition-colors group border border-transparent hover:border-border"
                  >
                    <div className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                      {project.name}
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                      {project.research_question || project.description || 'No description provided.'}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
