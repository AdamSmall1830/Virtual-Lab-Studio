import React from 'react';
import { Link } from 'wouter';
import { useProjects, getProjectsQueryKey } from '@/api';
import { useSession } from '@/api/session';
import type { ProjectOut } from '@/api';
import { FolderOpen, Calendar, Loader2, AlertTriangle, Plus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

function statusClasses(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-accent/10 text-accent';
    case 'completed':
      return 'bg-primary/10 text-primary';
    case 'paused':
      return 'bg-warning/10 text-warning';
    case 'archived':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-secondary/10 text-secondary';
  }
}

function ProjectCardSkeleton() {
  return (
    <div className="vls-reading-surface rounded-xl p-6 animate-pulse">
      <div className="h-4 w-24 bg-muted rounded mb-4" />
      <div className="h-6 w-2/3 bg-muted rounded mb-4" />
      <div className="h-3 w-full bg-muted rounded mb-2" />
      <div className="h-3 w-5/6 bg-muted rounded" />
    </div>
  );
}

export default function Projects() {
  const { workspaceId } = useSession();
  const projectsQuery = useProjects(workspaceId ?? '', {
    query: { enabled: Boolean(workspaceId), queryKey: getProjectsQueryKey(workspaceId ?? '') },
  });

  const projects = projectsQuery.data ?? [];

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">Organize meetings, agents, and evidence by context.</p>
        </div>
        <Link
          href="/app/projects/new"
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> New Project
        </Link>
      </header>

      {projectsQuery.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      ) : projectsQuery.isError ? (
        <div className="vls-glass rounded-xl p-12 text-center border border-destructive/30">
          <AlertTriangle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-display font-semibold mb-1">Couldn't load projects</h2>
          <p className="text-muted-foreground text-sm mb-4">There was a problem reaching the workspace.</p>
          <button
            onClick={() => projectsQuery.refetch()}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="vls-glass rounded-xl p-12 text-center border-dashed">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FolderOpen className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-display font-semibold mb-2">No projects yet</h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-6">
            Projects hold your research question, constraints, uploaded evidence, and all the multi-agent meetings you
            run to answer it.
          </p>
          <Link
            href="/app/projects/new"
            className="bg-foreground text-background px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-foreground/90 transition-colors inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Create your first project
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((project: ProjectOut) => (
            <Link
              key={project.id}
              href={`/app/projects/${project.id}`}
              className="vls-reading-surface rounded-xl p-6 hover:border-primary/50 transition-colors group flex flex-col"
            >
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    {project.discipline && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wider">
                        {project.discipline}
                      </span>
                    )}
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${statusClasses(project.status)}`}>
                      {project.status}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Calendar className="w-3 h-3" /> {formatDistanceToNow(new Date(project.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <h2 className="text-xl font-display font-semibold group-hover:text-primary transition-colors line-clamp-1">
                    {project.name}
                  </h2>
                </div>
              </div>

              <p className="text-sm text-muted-foreground line-clamp-3 mb-4 flex-1">
                {project.research_question || project.description || 'No description provided.'}
              </p>

              {Array.isArray(project.tags) && project.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-4 border-t border-border">
                  {project.tags.slice(0, 4).map((tag, i) => (
                    <span key={i} className="text-xs bg-background border border-border px-2 py-0.5 rounded">
                      {String(tag)}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      {projectsQuery.isFetching && !projectsQuery.isLoading && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Refreshing…
        </div>
      )}
    </div>
  );
}
