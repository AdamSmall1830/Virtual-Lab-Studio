import React, { useMemo, useState } from 'react';
import { useAgents, getListAgentsApiV1WorkspacesWorkspaceIdAgentsGetQueryKey } from '@/api';
import { useSession } from '@/api/session';
import type { AgentProfileOut } from '@/api';
import { Bot, Search, ShieldAlert, Info, Loader2, AlertTriangle, Thermometer } from 'lucide-react';

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function AgentSkeleton() {
  return (
    <div className="vls-reading-surface rounded-xl p-5 animate-pulse">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-32 bg-muted rounded" />
          <div className="h-3 w-20 bg-muted rounded" />
        </div>
      </div>
      <div className="h-3 w-full bg-muted rounded mb-2" />
      <div className="h-3 w-5/6 bg-muted rounded" />
    </div>
  );
}

export default function Agents() {
  const { workspaceId } = useSession();
  const [search, setSearch] = useState('');
  const agentsQuery = useAgents(workspaceId ?? '', {
    query: {
      enabled: Boolean(workspaceId),
      queryKey: getListAgentsApiV1WorkspacesWorkspaceIdAgentsGetQueryKey(workspaceId ?? ''),
    },
  });

  const agents = agentsQuery.data ?? [];

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => {
      const v = a.latest_version;
      return (
        a.title.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q) ||
        (v?.expertise ?? '').toLowerCase().includes(q) ||
        (v?.role ?? '').toLowerCase().includes(q)
      );
    });
  }, [agents, search]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-12">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Agent Studio</h1>
          <p className="text-sm text-muted-foreground mt-1">Specialist personas and their versioned operating procedures.</p>
        </div>
      </header>

      <div className="vls-glass rounded-xl px-4 py-3 flex items-start gap-3 text-sm text-muted-foreground border border-border/60">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <p>
          Agent profiles are versioned and seeded server-side. This library is read-only; select agents when composing a
          meeting.
        </p>
      </div>

      <div className="flex items-center gap-4 vls-glass p-2 rounded-xl">
        <div className="relative flex-1 w-full">
          <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search agents by title, expertise, or role..."
            className="w-full bg-transparent border-none focus:ring-0 pl-10 pr-4 py-2 text-sm text-foreground outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {agentsQuery.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <AgentSkeleton key={i} />
          ))}
        </div>
      ) : agentsQuery.isError ? (
        <div className="vls-glass rounded-xl p-12 text-center border border-destructive/30">
          <AlertTriangle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-display font-semibold mb-1">Couldn't load agents</h2>
          <p className="text-muted-foreground text-sm mb-4">There was a problem reaching the workspace.</p>
          <button
            onClick={() => agentsQuery.refetch()}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      ) : agents.length === 0 ? (
        <div className="vls-glass rounded-xl p-12 text-center border-dashed">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Bot className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-display font-semibold mb-2">No agents available</h2>
          <p className="text-muted-foreground max-w-md mx-auto">Agent profiles are seeded server-side for your workspace.</p>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">No agents found matching "{search}"</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAgents.map((agent: AgentProfileOut) => {
            const v = agent.latest_version;
            const accent = agent.accent || '#6366f1';
            const rules = asStringArray(v?.behavioral_rules);
            return (
              <div
                key={agent.id}
                className="vls-reading-surface rounded-xl p-5 transition-all group flex flex-col h-full hover:border-primary/30"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-xl shadow-sm shrink-0"
                      style={{ backgroundColor: `${accent}15`, border: `1px solid ${accent}30` }}
                    >
                      <Bot className="w-5 h-5" style={{ color: accent }} />
                    </div>
                    <div>
                      <h3 className="font-display font-semibold text-foreground group-hover:text-primary transition-colors">
                        {agent.title}
                      </h3>
                      {agent.category && (
                        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {agent.category}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {agent.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{agent.description}</p>
                )}

                <div className="space-y-3 flex-1 mb-4">
                  {v?.expertise && (
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1">Expertise</div>
                      <div className="text-sm line-clamp-2">{v.expertise}</div>
                    </div>
                  )}
                  {v?.goal && (
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1">Goal</div>
                      <div className="text-sm line-clamp-2">{v.goal}</div>
                    </div>
                  )}
                  {v?.role && (
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1">Role</div>
                      <div className="text-sm line-clamp-2">{v.role}</div>
                    </div>
                  )}
                  {rules.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3 text-warning" /> Rule
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-1 italic">"{rules[0]}"</div>
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-border flex items-center justify-between mt-auto text-xs text-muted-foreground">
                  {v ? (
                    <>
                      <span>v{v.version_number} · {v.default_role_type}</span>
                      {v.recommended_temperature !== null && v.recommended_temperature !== undefined && (
                        <span className="flex items-center gap-1">
                          <Thermometer className="w-3 h-3" /> {v.recommended_temperature}
                        </span>
                      )}
                    </>
                  ) : (
                    <span>No published version</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {agentsQuery.isFetching && !agentsQuery.isLoading && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Refreshing…
        </div>
      )}
    </div>
  );
}
