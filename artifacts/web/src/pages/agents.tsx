import React, { useState } from 'react';
import { useWorkspace } from '@/demo/useWorkspace';
import { mutate } from '@/demo/store';
import { Bot, Search, Plus, Filter, ShieldAlert, X, Save, Trash2, Archive, ArchiveRestore } from 'lucide-react';
import { format } from 'date-fns';
import type { AgentDefinition } from '@/demo/types';

export default function Agents() {
  const workspace = useWorkspace();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  
  const [isEditing, setIsEditing] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Partial<AgentDefinition> | null>(null);

  const filteredAgents = workspace.agents.filter(a => 
    (showArchived ? a.archived : !a.archived) &&
    (a.title.toLowerCase().includes(search.toLowerCase()) || 
    a.expertise.toLowerCase().includes(search.toLowerCase()) ||
    a.role.toLowerCase().includes(search.toLowerCase()))
  );

  const openNewAgent = () => {
    setEditingAgent({
      title: '',
      category: 'Custom',
      expertise: '',
      goal: '',
      role: '',
      description: '',
      behavioral_rules: [],
      default_tools: [],
      recommended_temperature: 0.7,
      accent: '#6366f1',
      icon: 'bot',
      default_role_type: 'member',
      archived: false
    });
    setIsEditing(true);
  };

  const openEditAgent = (agent: AgentDefinition) => {
    setEditingAgent({ ...agent, behavioral_rules: [...agent.behavioral_rules] });
    setIsEditing(true);
  };

  const handleSave = () => {
    if (!editingAgent || !editingAgent.title) return;

    mutate((s) => {
      const now = new Date().toISOString();
      const isNew = !editingAgent.slug;
      const slug = editingAgent.slug || editingAgent.title!.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      const fullAgent: AgentDefinition = {
        slug,
        title: editingAgent.title!,
        category: editingAgent.category || 'Custom',
        icon: editingAgent.icon || 'bot',
        accent: editingAgent.accent || '#6366f1',
        description: editingAgent.description || '',
        expertise: editingAgent.expertise || '',
        goal: editingAgent.goal || '',
        role: editingAgent.role || '',
        default_role_type: editingAgent.default_role_type || 'member',
        default_tools: editingAgent.default_tools || [],
        behavioral_rules: editingAgent.behavioral_rules || [],
        recommended_temperature: editingAgent.recommended_temperature || 0.7,
        version: isNew ? 1 : ((editingAgent.version || 1) + 1),
        createdAt: now,
        archived: editingAgent.archived || false
      };

      if (isNew) {
        s.agents.push(fullAgent);
        s.agentVersions[slug] = [fullAgent];
      } else {
        const idx = s.agents.findIndex(a => a.slug === slug);
        if (idx !== -1) {
          const old = s.agents[idx];
          if (!s.agentVersions[slug]) s.agentVersions[slug] = [];
          s.agentVersions[slug].push({ ...old });
          s.agents[idx] = fullAgent;
        }
      }
    });

    setIsEditing(false);
    setEditingAgent(null);
  };

  const handleDelete = (agent: AgentDefinition) => {
    const isReferenced = workspace.runs.some(r => r.frozenDefinition.agentSlugs.includes(agent.slug)) || 
                         workspace.drafts.some(d => d.agentSlugs.includes(agent.slug));
                         
    if (isReferenced) {
      if (confirm('This agent is referenced in existing runs or drafts and cannot be deleted. Archive it instead to hide it from future selection?')) {
        mutate(s => {
          const a = s.agents.find(x => x.slug === agent.slug);
          if (a) a.archived = true;
        });
      }
    } else {
      if (confirm('Are you sure you want to delete this agent? This cannot be undone.')) {
        mutate(s => {
          s.agents = s.agents.filter(x => x.slug !== agent.slug);
          delete s.agentVersions[agent.slug];
        });
      }
    }
  };

  const toggleArchive = (agent: AgentDefinition) => {
    mutate(s => {
      const a = s.agents.find(x => x.slug === agent.slug);
      if (a) a.archived = !a.archived;
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-12">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Agent Studio</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage specialist personas and standard operating procedures.</p>
        </div>
        <button onClick={openNewAgent} className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Agent
        </button>
      </header>

      <div className="flex flex-col sm:flex-row items-center gap-4 vls-glass p-2 rounded-xl">
        <div className="relative flex-1 w-full">
          <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input 
            type="text" 
            placeholder="Search agents by title, expertise, or role..." 
            className="w-full bg-transparent border-none focus:ring-0 pl-10 pr-4 py-2 text-sm text-foreground outline-none"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        
        <div className="flex items-center gap-2 px-2 sm:px-0">
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer whitespace-nowrap">
            <input 
              type="checkbox" 
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              className="rounded border-border text-primary focus:ring-primary"
            />
            Show archived
          </label>
          <button disabled title="Filter options available in next release" className="p-2 text-muted-foreground hover:text-foreground bg-background/50 rounded-lg border border-border disabled:opacity-50">
            <Filter className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredAgents.map(agent => (
          <div key={agent.slug} className={`vls-reading-surface rounded-xl p-5 transition-all group flex flex-col h-full ${agent.archived ? 'opacity-75 border-dashed hover:opacity-100' : 'hover:border-primary/30'}`}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div 
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-xl shadow-sm"
                  style={{ backgroundColor: `${agent.accent}15`, border: `1px solid ${agent.accent}30` }}
                >
                  <Bot className="w-5 h-5" style={{ color: agent.accent }} />
                </div>
                <div>
                  <h3 className="font-display font-semibold text-foreground group-hover:text-primary transition-colors">{agent.title}</h3>
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{agent.category}</div>
                    {agent.archived && <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-bold uppercase">Archived</span>}
                  </div>
                </div>
              </div>
            </div>
            
            <div className="space-y-3 flex-1 mb-4">
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">Expertise</div>
                <div className="text-sm line-clamp-2">{agent.expertise}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">Role</div>
                <div className="text-sm line-clamp-2">{agent.role}</div>
              </div>
              {agent.behavioral_rules.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3 text-warning" /> Rule
                  </div>
                  <div className="text-xs text-muted-foreground line-clamp-1 italic">
                    "{agent.behavioral_rules[0]}"
                  </div>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-border flex items-center justify-between mt-auto">
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <span>v{agent.version}</span>
                <span>•</span>
                <span>{format(new Date(agent.createdAt), 'MMM yyyy')}</span>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => toggleArchive(agent)} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                  {agent.archived ? <ArchiveRestore className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
                </button>
                <button onClick={() => handleDelete(agent)} className="text-xs font-medium text-destructive hover:text-destructive/80">
                  <Trash2 className="w-3 h-3" />
                </button>
                <button onClick={() => openEditAgent(agent)} className="text-xs font-medium text-primary hover:underline">Edit</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      
      {filteredAgents.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          No agents found matching "{search}"
        </div>
      )}

      {isEditing && editingAgent && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-md h-full bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right">
            <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <h2 className="text-lg font-display font-semibold">{editingAgent.slug ? 'Edit Agent' : 'New Agent'}</h2>
              <button onClick={() => setIsEditing(false)} className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </header>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Title</label>
                <input 
                  type="text" 
                  value={editingAgent.title} 
                  onChange={e => setEditingAgent({...editingAgent, title: e.target.value})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Expertise</label>
                <textarea 
                  value={editingAgent.expertise} 
                  onChange={e => setEditingAgent({...editingAgent, expertise: e.target.value})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Goal</label>
                <textarea 
                  value={editingAgent.goal} 
                  onChange={e => setEditingAgent({...editingAgent, goal: e.target.value})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Role Description</label>
                <textarea 
                  value={editingAgent.role} 
                  onChange={e => setEditingAgent({...editingAgent, role: e.target.value})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Behavioral Rules (one per line)</label>
                <textarea 
                  value={(editingAgent.behavioral_rules || []).join('\n')} 
                  onChange={e => setEditingAgent({...editingAgent, behavioral_rules: e.target.value.split('\n').filter(Boolean)})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm min-h-[100px] focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Temperature</label>
                  <input 
                    type="number" step="0.1" min="0" max="2"
                    value={editingAgent.recommended_temperature} 
                    onChange={e => setEditingAgent({...editingAgent, recommended_temperature: parseFloat(e.target.value) || 0.7})}
                    className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Accent Color (Hex)</label>
                  <input 
                    type="text" 
                    value={editingAgent.accent} 
                    onChange={e => setEditingAgent({...editingAgent, accent: e.target.value})}
                    className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-border shrink-0 flex justify-end">
              <button 
                onClick={handleSave}
                className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 flex items-center gap-2"
              >
                <Save className="w-4 h-4" /> Save {editingAgent.slug ? `v${(editingAgent.version || 1) + 1}` : 'Agent'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}