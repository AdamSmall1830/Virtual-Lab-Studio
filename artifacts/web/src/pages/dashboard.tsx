import React, { useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { 
  FolderOpen, 
  Activity, 
  Library, 
  Play, 
  Plus, 
  ChevronRight,
  Clock
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Dashboard() {
  const workspace = useWorkspace();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!workspace.onboarded) {
      setLocation('/sign-in');
    }
  }, [workspace.onboarded, setLocation]);

  const recentRuns = [...workspace.runs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const activeProject = workspace.projects[0];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">Welcome back to {workspace.workspaceName}</p>
        </div>
        <Link href="/app/meetings/new" className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
          <Play className="w-4 h-4" />
          New Meeting
        </Link>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="vls-glass p-5 rounded-xl border border-primary/20 bg-primary/5">
          <div className="flex items-center gap-3 text-primary mb-4">
            <FolderOpen className="w-5 h-5" />
            <h2 className="font-semibold font-display">Active Projects</h2>
          </div>
          <div className="text-3xl font-bold font-display">{workspace.projects.length}</div>
        </div>
        <div className="vls-glass p-5 rounded-xl">
          <div className="flex items-center gap-3 text-secondary mb-4">
            <Activity className="w-5 h-5" />
            <h2 className="font-semibold font-display">Total Runs</h2>
          </div>
          <div className="text-3xl font-bold font-display">{workspace.runs.length}</div>
        </div>
        <div className="vls-glass p-5 rounded-xl">
          <div className="flex items-center gap-3 text-accent mb-4">
            <Library className="w-5 h-5" />
            <h2 className="font-semibold font-display">Evidence Items</h2>
          </div>
          <div className="text-3xl font-bold font-display">{workspace.evidence.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="vls-reading-surface rounded-xl border border-border p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-display font-semibold">Recent Runs</h2>
              <Link href="/app/runs" className="text-sm text-primary hover:underline">View all</Link>
            </div>
            
            {recentRuns.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-lg bg-background/50">
                <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-50" />
                <h3 className="font-medium mb-1">No runs yet</h3>
                <p className="text-sm text-muted-foreground mb-4">Start a multi-agent meeting to see it here.</p>
                <Link href="/app/meetings/new" className="inline-flex items-center gap-2 text-sm font-medium bg-primary/10 text-primary px-4 py-2 rounded-lg hover:bg-primary/20 transition-colors">
                  <Play className="w-4 h-4" /> Start from Template
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {recentRuns.map(run => (
                  <Link key={run.id} href={`/app/runs/${run.id}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-background/80 transition-colors group border border-transparent hover:border-border">
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                        run.status === 'completed' ? 'bg-accent' :
                        run.status === 'running' ? 'bg-primary animate-pulse' :
                        run.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground'
                      }`} />
                      <div>
                        <div className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">{run.title}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span className="capitalize">{run.status}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {formatDistanceToNow(new Date(run.createdAt), { addSuffix: true })}</span>
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
          <div className="vls-glass rounded-xl p-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
              <FolderOpen className="w-32 h-32" />
            </div>
            <h2 className="text-lg font-display font-semibold mb-2 relative z-10">Current Focus</h2>
            {activeProject ? (
              <div className="relative z-10">
                <Link href={`/app/projects/${activeProject.id}`} className="block group">
                  <div className="font-medium text-lg group-hover:text-primary transition-colors line-clamp-2 mt-4 mb-2">
                    {activeProject.name}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-3 mb-4">
                    {activeProject.description}
                  </p>
                  <div className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Open Project <ChevronRight className="w-4 h-4" />
                  </div>
                </Link>
              </div>
            ) : (
              <div className="text-center py-8 relative z-10">
                <p className="text-sm text-muted-foreground mb-4">Create a project to organize your meetings and evidence.</p>
                <Link href="/app/projects/new" className="inline-flex items-center gap-2 text-sm font-medium bg-white/10 px-4 py-2 rounded-lg hover:bg-white/20 transition-colors">
                  <Plus className="w-4 h-4" /> Create Project
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
