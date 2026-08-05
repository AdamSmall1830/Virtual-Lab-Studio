import React from 'react';
import { AgentProfile } from '@workspace/api-client-react';
import { GlassPanel } from './glass-panel';
import { BrainCircuit, Cpu } from 'lucide-react';

export function AgentCard({ agent, onClick }: { agent: AgentProfile, onClick?: () => void }) {
  return (
    <GlassPanel 
      className={`p-5 flex flex-col gap-3 border-t-4 transition-colors ${onClick ? 'cursor-pointer hover:bg-muted/30' : ''}`}
      style={{ borderTopColor: agent.accentColor || 'hsl(var(--primary))' }}
      onClick={onClick}
    >
      <div className="flex justify-between items-start">
        <h3 className="font-display font-bold text-lg">{agent.title}</h3>
        <div className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-surface-strong border border-border/50 text-muted-foreground capitalize shrink-0 ml-2">
          {agent.provider === 'demo' ? <BrainCircuit className="w-3 h-3 text-secondary" /> : <Cpu className="w-3 h-3" />}
          {agent.provider}
        </div>
      </div>
      
      {agent.shortLabel && <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{agent.shortLabel}</div>}
      
      <p className="text-sm text-muted-foreground line-clamp-2" title={agent.expertise}>
        <span className="font-semibold text-foreground/80">Expertise:</span> {agent.expertise}
      </p>
      
      <div className="mt-auto pt-3 border-t border-border/40 flex justify-between items-center text-xs text-muted-foreground">
        <span className="truncate mr-2">{agent.model}</span>
        {agent.isSystem && <span className="bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded shrink-0">System</span>}
      </div>
    </GlassPanel>
  );
}
