import React from 'react';
import { useListRuns } from '@workspace/api-client-react';
import { PageHeader } from '@/components/ui/page-header';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { Play, Activity, Clock, Users } from 'lucide-react';
import { RunStatusBadge } from '@/components/ui/run-status-badge';
import { format } from 'date-fns';

export default function RunList() {
  const { data: runs, isLoading } = useListRuns();

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto w-full">
      <PageHeader 
        title="Runs" 
        description="History and queue of all research meeting executions."
      >
        <Link href="/app/meetings/new">
          <Button><Play className="w-4 h-4 mr-2" /> New Meeting</Button>
        </Link>
      </PageHeader>

      <GlassPanel className="overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center animate-pulse text-muted-foreground flex flex-col gap-4">
            <div className="h-16 bg-muted/50 rounded"></div>
            <div className="h-16 bg-muted/50 rounded"></div>
            <div className="h-16 bg-muted/50 rounded"></div>
          </div>
        ) : runs?.length === 0 ? (
          <div className="p-16 text-center flex flex-col items-center gap-4">
            <Activity className="w-12 h-12 text-primary/20" />
            <div>
              <h3 className="text-xl font-display font-semibold mb-1">No runs executed yet</h3>
              <p className="text-muted-foreground">Start a meeting to see it appear here.</p>
            </div>
            <Link href="/app/meetings/new">
              <Button className="mt-4"><Play className="w-4 h-4 mr-2" /> Start Meeting</Button>
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {runs?.map(run => (
              <Link key={run.id} href={['running', 'paused', 'queued', 'validating', 'pause_pending', 'cancelling'].includes(run.status) ? `/app/runs/${run.id}/live` : `/app/runs/${run.id}`} className="block hover:bg-muted/50 transition-colors p-4 md:p-5">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-foreground text-lg">{run.title}</h3>
                      <div className="md:hidden"><RunStatusBadge status={run.status} isSimulation={run.isSimulation} /></div>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                      {run.projectName && (
                        <span className="font-medium text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                          {run.projectName}
                        </span>
                      )}
                      <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {run.participants.length} agents</span>
                      <span className="flex items-center gap-1"><Activity className="w-3.5 h-3.5" /> {run.rounds} rounds</span>
                      <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {format(new Date(run.createdAt), 'MMM d, HH:mm')}</span>
                      {run.tokensUsed > 0 && <span>{run.tokensUsed.toLocaleString()} tokens</span>}
                    </div>
                  </div>
                  
                  <div className="hidden md:block shrink-0">
                    <RunStatusBadge status={run.status} isSimulation={run.isSimulation} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
