import React from 'react';
import { Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { LayoutTemplate, Users, Play, ExternalLink } from 'lucide-react';

export default function Templates() {
  const workspace = useWorkspace();

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto">
      <header>
        <h1 className="text-3xl font-display font-bold">Template Library</h1>
        <p className="text-sm text-muted-foreground mt-1">Standardized academic and analytical meeting patterns.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {workspace.templates.map(template => (
          <div key={template.slug} className="vls-reading-surface rounded-xl p-6 flex flex-col">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <LayoutTemplate className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{template.category}</span>
              </div>
              <div className="text-xs font-medium bg-background px-2 py-1 rounded border border-border capitalize">
                {template.meeting_type} mode
              </div>
            </div>
            
            <h2 className="text-xl font-display font-semibold mb-2">{template.name}</h2>
            <p className="text-sm text-muted-foreground mb-6 flex-1">
              {template.description}
            </p>

            <div className="bg-background/50 rounded-lg p-4 mb-6 border border-border/50">
              <div className="text-xs font-semibold text-foreground mb-3 flex items-center gap-2">
                <Users className="w-4 h-4 text-secondary" /> Suggested Council
              </div>
              <div className="flex flex-wrap gap-2">
                {template.suggested_agents.map((sa, i) => {
                  const agent = workspace.agents.find(a => a.slug === sa.agent_slug);
                  return (
                    <div key={i} className="text-xs bg-background border border-border px-2 py-1 rounded flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${sa.role_type === 'lead' ? 'bg-primary' : sa.role_type === 'critic' ? 'bg-warning' : 'bg-secondary'}`} />
                      {agent ? agent.title : sa.agent_slug}
                      {sa.required && <span className="text-muted-foreground">*</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-border mt-auto">
              <div className="text-xs text-muted-foreground">
                Default: {template.default_rounds} rounds
              </div>
              <Link 
                href={`/app/meetings/new?template=${template.slug}`}
                className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2 transition-transform active:scale-95"
              >
                <Play className="w-4 h-4" /> Use Template
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
