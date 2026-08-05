import React from 'react';
import { useListProjects } from '@workspace/api-client-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Plus, FolderGit2, Activity, Clock, Tag } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';

export default function ProjectList() {
  const { data: projects, isLoading } = useListProjects();

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto w-full">
      <PageHeader 
        title="Projects" 
        description="Organize your research agendas, hypotheses, and runs into discrete workspaces."
      >
        <Link href="/app/projects/new">
          <Button><Plus className="w-4 h-4 mr-2" /> New Project</Button>
        </Link>
      </PageHeader>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          {[1,2,3].map(i => <div key={i} className="h-32 bg-muted/50 rounded-xl animate-pulse"></div>)}
        </div>
      ) : projects?.length === 0 ? (
        <GlassPanel className="p-12 text-center flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-2">
            <FolderGit2 className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-xl font-display font-semibold mb-1">No projects yet</h3>
            <p className="text-muted-foreground">Create a project to start organizing your multi-agent research.</p>
          </div>
          <Link href="/app/projects/new">
            <Button className="mt-4"><Plus className="w-4 h-4 mr-2" /> Create Project</Button>
          </Link>
        </GlassPanel>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects?.map(project => (
            <Link key={project.id} href={`/app/projects/${project.id}`}>
              <GlassPanel className="p-5 hover:bg-muted/50 transition-colors cursor-pointer border-border/50 h-full flex flex-col">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="font-semibold text-lg text-foreground font-display">{project.name}</h3>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-surface-strong border border-border text-muted-foreground capitalize">
                    {project.status}
                  </span>
                </div>
                
                {project.abstract && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-4">{project.abstract}</p>
                )}
                
                <div className="flex flex-wrap gap-2 mb-4">
                  {project.tags?.map(t => (
                    <span key={t} className="text-xs flex items-center gap-1 bg-secondary/10 text-secondary px-1.5 py-0.5 rounded border border-secondary/20">
                      <Tag className="w-3 h-3" /> {t}
                    </span>
                  ))}
                  {project.domain && (
                    <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded border border-border">
                      {project.domain}
                    </span>
                  )}
                </div>

                <div className="mt-auto pt-4 border-t border-border/40 flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> {project.runCount || 0} runs</span>
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Updated {format(new Date(project.updatedAt), 'MMM d, yyyy')}</span>
                </div>
              </GlassPanel>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
