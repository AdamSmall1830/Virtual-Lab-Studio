import React from 'react';
import { Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { FolderOpen, Plus, Calendar, Activity, Database } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Projects() {
  const workspace = useWorkspace();

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">Organize meetings, agents, and evidence by context.</p>
        </div>
        <Link href="/app/projects/new" className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Project
        </Link>
      </header>

      {workspace.projects.length === 0 ? (
        <div className="vls-glass rounded-xl p-12 text-center border-dashed">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <FolderOpen className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-display font-semibold mb-2">No projects yet</h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-6">
            Projects hold your research question, constraints, uploaded evidence, and all the multi-agent meetings you run to answer it.
          </p>
          <Link href="/app/projects/new" className="bg-foreground text-background px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-foreground/90 transition-colors inline-flex items-center gap-2">
            <Plus className="w-4 h-4" /> Create your first project
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {workspace.projects.map((project) => {
            const projectRuns = workspace.runs.filter(r => r.projectId === project.id);
            const projectEvidence = workspace.evidence.filter(e => e.projectId === project.id);
            
            return (
              <Link key={project.id} href={`/app/projects/${project.id}`} className="vls-reading-surface rounded-xl p-6 hover:border-primary/50 transition-colors group flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wider">{project.discipline}</span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> {formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    <h2 className="text-xl font-display font-semibold group-hover:text-primary transition-colors line-clamp-1">{project.name}</h2>
                  </div>
                </div>
                
                <p className="text-sm text-muted-foreground line-clamp-3 mb-6 flex-1">
                  {project.description}
                </p>

                <div className="flex items-center gap-4 text-sm text-muted-foreground pt-4 border-t border-border">
                  <div className="flex items-center gap-1.5" title="Completed Runs">
                    <Activity className="w-4 h-4 text-secondary" />
                    <span className="font-medium text-foreground">{projectRuns.length}</span> runs
                  </div>
                  <div className="flex items-center gap-1.5" title="Evidence Items">
                    <Database className="w-4 h-4 text-accent" />
                    <span className="font-medium text-foreground">{projectEvidence.length}</span> sources
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
