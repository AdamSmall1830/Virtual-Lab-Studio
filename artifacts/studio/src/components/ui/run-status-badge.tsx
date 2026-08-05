import React from 'react';
import { cn } from '@/lib/utils';
import { RunStatus } from '@workspace/api-client-react';

export function RunStatusBadge({ status, isSimulation, className }: { status: string, isSimulation?: boolean, className?: string }) {
  const map: Record<string, { label: string, classes: string }> = {
    [RunStatus.draft]: { label: 'Draft', classes: 'bg-muted text-muted-foreground border-border' },
    [RunStatus.queued]: { label: 'Queued', classes: 'bg-info/10 text-info border-info/20' },
    [RunStatus.validating]: { label: 'Validating', classes: 'bg-info/10 text-info border-info/20' },
    [RunStatus.running]: { label: 'Running', classes: 'bg-primary/10 text-primary border-primary/20 animate-pulse' },
    [RunStatus.pause_pending]: { label: 'Pausing...', classes: 'bg-warning/10 text-warning border-warning/20' },
    [RunStatus.paused]: { label: 'Paused', classes: 'bg-warning/10 text-warning border-warning/20' },
    [RunStatus.cancelling]: { label: 'Cancelling...', classes: 'bg-danger/10 text-danger border-danger/20' },
    [RunStatus.cancelled]: { label: 'Cancelled', classes: 'bg-danger/10 text-danger border-danger/20' },
    [RunStatus.completed]: { label: 'Completed', classes: 'bg-accent/10 text-accent border-accent/20' },
    [RunStatus.failed]: { label: 'Failed', classes: 'bg-danger/10 text-danger border-danger/20' },
    [RunStatus.budget_exceeded]: { label: 'Budget Exceeded', classes: 'bg-danger/10 text-danger border-danger/20' },
  };

  const config = map[status] || map[RunStatus.draft];

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", config.classes, className)}>
        {config.label}
      </span>
      {isSimulation && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-secondary/10 text-secondary border-secondary/20">
          Simulation
        </span>
      )}
    </div>
  );
}
