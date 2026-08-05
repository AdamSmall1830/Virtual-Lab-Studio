import React, { useState } from 'react';
import { useWorkspace } from '@/demo/useWorkspace';
import { mutate, uid } from '@/demo/store';
import { Search, Database, Plus, Quote, ExternalLink, Hash, X, Save, FileText, Pencil, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import type { EvidenceItem } from '@/demo/types';

export default function Evidence() {
  const workspace = useWorkspace();
  const [search, setSearch] = useState('');
  
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceItem | null>(null);

  const [formData, setFormData] = useState({
    title: '',
    source_type: 'note',
    content: '',
    citation: '',
    projectId: workspace.projects[0]?.id || ''
  });

  const filtered = workspace.evidence.filter(e => 
    e.title.toLowerCase().includes(search.toLowerCase()) || 
    e.content.toLowerCase().includes(search.toLowerCase())
  );

  const openNew = () => {
    setEditingId(null);
    setFormData({
      title: '',
      source_type: 'note',
      content: '',
      citation: '',
      projectId: workspace.projects[0]?.id || ''
    });
    setIsAdding(true);
  };

  const openEdit = (ev: EvidenceItem) => {
    setEditingId(ev.evidence_id);
    setFormData({
      title: ev.title,
      source_type: ev.source_type,
      content: ev.content,
      citation: ev.citation || '',
      projectId: ev.projectId
    });
    setIsAdding(true);
  };

  const handleSave = () => {
    if (!formData.title || !formData.content) return;
    
    mutate(s => {
      if (editingId) {
        const ev = s.evidence.find(e => e.evidence_id === editingId);
        if (ev) {
          ev.title = formData.title;
          ev.source_type = formData.source_type;
          ev.content = formData.content;
          ev.citation = formData.citation || null;
          ev.projectId = formData.projectId;
        }
      } else {
        s.evidence.push({
          evidence_id: uid('ev'),
          source_type: formData.source_type,
          title: formData.title,
          content: formData.content,
          citation: formData.citation || null,
          projectId: formData.projectId,
          trusted_metadata: { author: 'Demo User', created_at: new Date().toISOString() }
        });
      }
    });
    
    setIsAdding(false);
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this evidence? It will no longer be available for future runs.')) {
      mutate(s => {
        s.evidence = s.evidence.filter(e => e.evidence_id !== id);
      });
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-12 relative h-full">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Evidence Library</h1>
          <p className="text-sm text-muted-foreground mt-1">Cross-project repository of literature, data, and notes.</p>
        </div>
        <button onClick={openNew} className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Source
        </button>
      </header>

      <div className="vls-glass p-2 rounded-xl flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input 
            type="text" 
            placeholder="Search evidence..." 
            className="w-full bg-transparent border-none focus:ring-0 pl-10 pr-4 py-2 text-sm text-foreground outline-none"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-4">
        {filtered.map(ev => {
          const project = workspace.projects.find(p => p.id === ev.projectId);
          
          return (
            <div key={ev.evidence_id} className="vls-reading-surface rounded-xl p-6 border-l-4 border-l-accent flex flex-col md:flex-row gap-6 group">
              <div className="flex-1 space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Database className="w-4 h-4 text-accent" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{ev.source_type}</span>
                    <span className="text-muted-foreground">•</span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
                      <Hash className="w-3 h-3" /> {ev.evidence_id}
                    </span>
                  </div>
                  <h3 className="text-lg font-display font-semibold">{ev.title}</h3>
                  {ev.citation && (
                    <div className="text-sm text-muted-foreground mt-1 italic border-l-2 border-border pl-3 ml-1 py-0.5">
                      {ev.citation}
                    </div>
                  )}
                </div>
                
                <div className="bg-background/50 rounded-lg p-4 text-sm font-serif leading-relaxed text-foreground border border-border/50 relative">
                  <Quote className="w-8 h-8 absolute top-2 left-2 text-primary/5 -z-0" />
                  <div className="relative z-10 line-clamp-4">
                    {ev.content}
                  </div>
                </div>
              </div>
              
              <div className="w-full md:w-64 shrink-0 space-y-4 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-6 text-sm flex flex-col">
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">Project</div>
                  <div className="font-medium truncate">{project?.name || 'Unknown'}</div>
                </div>
                {ev.trusted_metadata?.author && (
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mb-1">Author</div>
                    <div className="truncate">{ev.trusted_metadata.author}</div>
                  </div>
                )}
                {ev.trusted_metadata?.created_at && (
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mb-1">Date</div>
                    <div>{format(new Date(ev.trusted_metadata.created_at), 'PP')}</div>
                  </div>
                )}
                <div className="pt-2 flex-1 flex flex-col justify-end">
                  <button onClick={() => setSelectedEvidence(ev)} className="text-primary font-medium flex items-center gap-1 hover:underline w-fit">
                    View full text <ExternalLink className="w-3 h-3" />
                  </button>
                  <div className="flex items-center gap-3 mt-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => openEdit(ev)} className="text-xs font-medium text-foreground hover:text-primary flex items-center gap-1">
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button onClick={() => handleDelete(ev.evidence_id)} className="text-xs font-medium text-destructive hover:underline flex items-center gap-1">
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        
        {filtered.length === 0 && (
          <div className="text-center py-20 text-muted-foreground vls-glass rounded-xl border-dashed">
            <Database className="w-10 h-10 mx-auto mb-3 opacity-20" />
            No evidence found.
          </div>
        )}
      </div>

      {isAdding && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-md h-full bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right">
            <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <h2 className="text-lg font-display font-semibold">{editingId ? 'Edit Source' : 'Add Source'}</h2>
              <button onClick={() => setIsAdding(false)} className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </header>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Title *</label>
                <input 
                  type="text" 
                  value={formData.title} 
                  onChange={e => setFormData({...formData, title: e.target.value})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Project context</label>
                <select 
                  value={formData.projectId}
                  onChange={e => setFormData({...formData, projectId: e.target.value})}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
                >
                  {workspace.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Source Type</label>
                <select 
                  value={formData.source_type}
                  onChange={e => setFormData({...formData, source_type: e.target.value})}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
                >
                  <option value="note">Note</option>
                  <option value="excerpt">Excerpt / Literature</option>
                  <option value="data">Data Summary</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Citation / URL (Optional)</label>
                <input 
                  type="text" 
                  value={formData.citation} 
                  onChange={e => setFormData({...formData, citation: e.target.value})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Full Content *</label>
                <textarea 
                  value={formData.content} 
                  onChange={e => setFormData({...formData, content: e.target.value})}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm min-h-[200px] focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>
            </div>

            <div className="p-4 border-t border-border shrink-0 flex justify-end">
              <button 
                onClick={handleSave}
                disabled={!formData.title || !formData.content}
                className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50"
              >
                <Save className="w-4 h-4" /> {editingId ? 'Save Changes' : 'Save Source'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedEvidence && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex justify-center p-4 sm:p-8">
          <div className="w-full max-w-3xl h-full bg-background border border-border shadow-2xl rounded-xl flex flex-col animate-in zoom-in-95">
            <header className="flex items-center justify-between p-4 sm:p-6 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <FileText className="w-6 h-6 text-accent" />
                <h2 className="text-xl font-display font-semibold line-clamp-1">{selectedEvidence.title}</h2>
              </div>
              <button onClick={() => setSelectedEvidence(null)} className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </header>
            
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-secondary/5 font-serif text-[15px] leading-relaxed whitespace-pre-wrap">
              {selectedEvidence.content}
            </div>

            <div className="p-4 sm:p-6 border-t border-border shrink-0 text-sm text-muted-foreground">
              {selectedEvidence.citation ? (
                <div><strong>Citation:</strong> {selectedEvidence.citation}</div>
              ) : (
                <div>No formal citation provided.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}