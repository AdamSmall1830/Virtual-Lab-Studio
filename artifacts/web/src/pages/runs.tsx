import React from 'react';
import { Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { Activity, Play, CheckCircle2, XCircle, Clock, AlertTriangle, ChevronRight } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

export default function Runs() {
  const workspace = useWorkspace();
  const runs = [...workspace.runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="w-5 h-5 text-accent" />;
      case 'running': return <Activity className="w-5 h-5 text-primary animate-pulse" />;
      case 'failed': return <XCircle className="w-5 h-5 text-destructive" />;
      case 'paused': 
      case 'pause_pending': return <AlertTriangle className="w-5 h-5 text-warning" />;
      case 'cancelled': return <XCircle className="w-5 h-5 text-muted-foreground" />;
      default: return <Clock className="w-5 h-5 text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-12">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Run History</h1>
          <p className="text-sm text-muted-foreground mt-1">Traceability and audit log for all simulated multi-agent meetings.</p>
        </div>
        <Link href="/app/meetings/new" className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
          <Play className="w-4 h-4" /> Start New Run
        </Link>
      </header>

      {runs.length === 0 ? (
        <div className="vls-glass rounded-xl p-16 text-center border-dashed">
          <Activity className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <h2 className="text-xl font-display font-semibold mb-2">No runs executed</h2>
          <p className="text-muted-foreground max-w-sm mx-auto mb-6">Start a meeting from a template or scratch to see live execution and structural summaries here.</p>
          <Link href="/app/meetings/new" className="bg-foreground text-background px-6 py-2.5 rounded-lg text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/90 transition-colors">
            <Play className="w-4 h-4" /> Configure a Meeting
          </Link>
        </div>
      ) : (
        <div className="vls-reading-surface rounded-xl overflow-hidden divide-y divide-border border border-border">
          {runs.map(run => {
            const project = workspace.projects.find(p => p.id === run.projectId);
            const isLive = ['running', 'paused', 'pause_pending'].includes(run.status);
            
            return (
              <div key={run.id} className="group relative flex flex-col md:flex-row md:items-center gap-4 p-5 hover:bg-background/50 transition-colors">
                <Link href={isLive ? `/app/runs/${run.id}/live` : `/app/runs/${run.id}`} className="absolute inset-0 z-0" />
                
                <div className="relative z-10 shrink-0 mt-1 md:mt-0">
                  <StatusIcon status={run.status} />
                </div>
                
                <div className="relative z-10 flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-background border border-border uppercase tracking-wider text-muted-foreground">
                      {run.meetingType}
                    </span>
                    {project && (
                      <span className="text-xs text-muted-foreground truncate max-w-[200px] hidden sm:inline-block">
                        in {project.name}
                      </span>
                    )}
                  </div>
                  <h3 className="text-lg font-display font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                    {run.title}
                  </h3>
                  <div className="text-sm text-muted-foreground mt-1 flex flex-wrap items-center gap-3">
                    <span className="flex items-center gap-1 font-mono text-xs">
                      {format(new Date(run.createdAt), 'MMM d, HH:mm')}
                    </span>
                    {run.completedAt && (
                      <>
                        <span>•</span>
                        <span>{run.usage.wallSeconds}s duration</span>
                        <span>•</span>
                        <span>{run.usage.providerCalls} calls</span>
                        <span>•</span>
                        <span>{(run.usage.tokensIn + run.usage.tokensOut).toLocaleString()} tokens</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="relative z-10 shrink-0 flex items-center justify-end gap-4 md:w-48 text-right">
                  {isLive ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold animate-pulse">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary" /> Live
                    </span>
                  ) : (
                    <div className="text-xs text-muted-foreground font-mono">
                      {formatDistanceToNow(new Date(run.createdAt), { addSuffix: true })}
                    </div>
                  )}
                  <ChevronRight className="w-5 h-5 text-muted-foreground opacity-50 group-hover:opacity-100 group-hover:text-primary transition-all group-hover:translate-x-1" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
