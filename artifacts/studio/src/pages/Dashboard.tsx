import React from 'react';
import { useGetDashboardSummary, useListProjects } from '@workspace/api-client-react';
import { GlassPanel } from '@/components/ui/glass-panel';
import { PageHeader } from '@/components/ui/page-header';
import { Bot, FolderGit2, Activity, Clock, Zap } from 'lucide-react';
import { Link } from 'wouter';
import { RunStatusBadge } from '@/components/ui/run-status-badge';
import { format } from 'date-fns';

export default function Dashboard() {
  const { data, isLoading } = useGetDashboardSummary();
  const { data: projects } = useListProjects();
  const recentProjects = projects?.slice(0, 5);

  if (isLoading) {
    return <div className="p-6 md:p-8 max-w-6xl mx-auto w-full animate-pulse flex flex-col space-y-8">
      <div className="h-12 bg-muted/50 rounded w-1/4"></div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"><div className="h-32 bg-muted/50 rounded"></div><div className="h-32 bg-muted/50 rounded"></div><div className="h-32 bg-muted/50 rounded"></div><div className="h-32 bg-muted/50 rounded"></div></div>
    </div>;
  }

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto w-full">
      <PageHeader 
        title="Workspace Overview" 
        description="Monitor your active research projects, recent deliberation runs, and agent usage."
      />

      {/* KPI Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <GlassPanel className="p-5 flex flex-col gap-2 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-primary/5 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
          <div className="flex items-center gap-2 text-muted-foreground mb-1 text-sm font-medium">
            <FolderGit2 className="w-4 h-4 text-primary" /> Active Projects
          </div>
          <div className="text-3xl font-display font-bold">{data?.projectCount || 0}</div>
        </GlassPanel>
        
        <GlassPanel className="p-5 flex flex-col gap-2 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-secondary/5 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
          <div className="flex items-center gap-2 text-muted-foreground mb-1 text-sm font-medium">
            <Bot className="w-4 h-4 text-secondary" /> Agent Profiles
          </div>
          <div className="text-3xl font-display font-bold">{data?.agentCount || 0}</div>
        </GlassPanel>

        <GlassPanel className="p-5 flex flex-col gap-2 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-accent/5 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
          <div className="flex items-center gap-2 text-muted-foreground mb-1 text-sm font-medium">
            <Activity className="w-4 h-4 text-accent" /> Total Runs
          </div>
          <div className="text-3xl font-display font-bold">
             {Object.values(data?.runCounts || {}).reduce((a,b) => a+b, 0)}
          </div>
        </GlassPanel>

        <GlassPanel className="p-5 flex flex-col gap-2 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-warning/5 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
          <div className="flex items-center gap-2 text-muted-foreground mb-1 text-sm font-medium">
            <Zap className="w-4 h-4 text-warning" /> Tokens Processed
          </div>
          <div className="text-3xl font-display font-bold">
            {new Intl.NumberFormat('en-US', { notation: "compact", compactDisplay: "short" }).format(data?.totalTokens || 0)}
          </div>
        </GlassPanel>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-display font-semibold">Recent Projects</h2>
            <Link href="/app/projects" className="text-sm text-primary hover:underline font-medium">View all</Link>
          </div>
          <div className="flex flex-col gap-3">
            {!recentProjects || recentProjects.length === 0 ? (
              <GlassPanel className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2">
                <FolderGit2 className="w-8 h-8 opacity-20" />
                <p>No projects yet.</p>
              </GlassPanel>
            ) : (
              recentProjects.map(project => (
                <Link key={project.id} href={`/app/projects/${project.id}`}>
                  <GlassPanel className="p-4 hover:bg-muted/50 transition-colors cursor-pointer border-border/50">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-semibold text-foreground">{project.name}</h3>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-surface-strong border border-border text-muted-foreground capitalize">{project.status}</span>
                    </div>
                    {project.abstract && <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{project.abstract}</p>}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> {project.runCount || 0} runs</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Updated {format(new Date(project.updatedAt), 'MMM d, yyyy')}</span>
                    </div>
                  </GlassPanel>
                </Link>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-display font-semibold">Recent Runs</h2>
            <Link href="/app/runs" className="text-sm text-primary hover:underline font-medium">View all</Link>
          </div>
          <div className="flex flex-col gap-3">
            {data?.recentRuns?.length === 0 ? (
              <GlassPanel className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2">
                <Activity className="w-8 h-8 opacity-20" />
                <p>No runs yet.</p>
              </GlassPanel>
            ) : (
              data?.recentRuns?.map(run => (
                <Link key={run.id} href={['running', 'paused', 'queued', 'validating', 'pause_pending', 'cancelling'].includes(run.status) ? `/app/runs/${run.id}/live` : `/app/runs/${run.id}`}>
                  <GlassPanel className="p-4 hover:bg-muted/50 transition-colors cursor-pointer border-border/50 flex flex-col gap-2">
                    <div className="flex justify-between items-start">
                      <div className="font-medium text-foreground">{run.title}</div>
                      <RunStatusBadge status={run.status} isSimulation={run.isSimulation} />
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground mt-1">
                      {run.projectName && <span className="bg-surface-strong px-1.5 py-0.5 rounded border border-border">{run.projectName}</span>}
                      <span className="px-1.5 py-0.5 rounded border border-border/50">{run.rounds} rounds • {run.participants.length} agents</span>
                      <span className="flex items-center"><Clock className="w-3 h-3 mr-1" /> {format(new Date(run.createdAt), 'MMM d, HH:mm')}</span>
                    </div>
                  </GlassPanel>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
