import React, { useState } from 'react';
import { useRoute, useLocation, Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { mutate, uid } from '@/demo/store';
import { 
  ArrowLeft, FileText, Activity, Database, GitMerge, Settings, Save, 
  FlaskConical, CheckSquare, ListTodo, Plus, Trash2, ShieldAlert
} from 'lucide-react';
import ProjectCompare from './project-compare';
import { format } from 'date-fns';

export default function ProjectDetail() {
  const [matchNew] = useRoute('/app/projects/new');
  const [matchDetail, params] = useRoute('/app/projects/:projectId/:tab?');
  const [, setLocation] = useLocation();
  const workspace = useWorkspace();
  
  const isNew = !!matchNew;
  const projectId = isNew ? null : params?.projectId;
  const tab = params?.tab || 'overview';
  
  const project = workspace.projects.find(p => p.id === projectId || p.slug === projectId);

  const [formData, setFormData] = useState({
    name: project?.name || '',
    discipline: project?.discipline || 'Materials Science',
    description: project?.description || '',
    research_question: project?.research_question || '',
    hypotheses: project?.hypotheses.join('\n') || '',
    objectives: project?.objectives.join('\n') || '',
    constraints: project?.constraints.join('\n') || '',
    human_decision_supported: project?.human_decision_supported || '',
  });

  if (!isNew && !project) {
    return <div className="p-8 text-center text-muted-foreground">Project not found</div>;
  }

  const handleSave = () => {
    if (!formData.name) return;
    
    if (isNew) {
      const newId = uid('proj');
      mutate(s => {
        s.projects.push({
          id: newId,
          slug: formData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          name: formData.name,
          discipline: formData.discipline,
          description: formData.description,
          status: 'active',
          research_question: formData.research_question,
          hypotheses: formData.hypotheses.split('\n').filter(Boolean),
          objectives: formData.objectives.split('\n').filter(Boolean),
          constraints: formData.constraints.split('\n').filter(Boolean),
          human_decision_supported: formData.human_decision_supported,
          disclosures: [],
          tags: [],
          createdAt: new Date().toISOString()
        });
      });
      setLocation(`/app/projects/${newId}`);
    } else if (project) {
      mutate(s => {
        const p = s.projects.find(x => x.id === project.id);
        if (p) {
          p.name = formData.name;
          p.discipline = formData.discipline;
          p.description = formData.description;
          p.research_question = formData.research_question;
          p.hypotheses = formData.hypotheses.split('\n').filter(Boolean);
          p.objectives = formData.objectives.split('\n').filter(Boolean);
          p.constraints = formData.constraints.split('\n').filter(Boolean);
          p.human_decision_supported = formData.human_decision_supported;
        }
      });
    }
  };

  const handleDeleteProject = () => {
    if (!project) return;
    if (confirm(`Are you sure you want to delete ${project.name}? This will also delete its drafts, evidence, notebook entries, and comparisons. Completed runs will be retained in the global run history with their frozen data.`)) {
      mutate(s => {
        s.projects = s.projects.filter(p => p.id !== project.id);
        s.drafts = s.drafts.filter(d => d.projectId !== project.id);
        s.evidence = s.evidence.filter(e => e.projectId !== project.id);
        s.notebook = s.notebook.filter(n => n.projectId !== project.id);
        s.comparisons = s.comparisons.filter(c => c.projectId !== project.id);
      });
      setLocation('/app/projects');
    }
  };

  const projectRuns = project ? workspace.runs.filter(r => r.projectId === project.id) : [];
  const projectEvidence = project ? workspace.evidence.filter(e => e.projectId === project.id) : [];
  const projectNotebook = project ? workspace.notebook.filter(n => n.projectId === project.id) : [];

  const tabs = [
    { id: 'overview', label: 'Overview', icon: FileText },
    { id: 'meetings', label: 'Meetings', icon: Activity, count: projectRuns.length },
    { id: 'evidence', label: 'Evidence', icon: Database, count: projectEvidence.length },
    { id: 'notebook', label: 'Notebook', icon: ListTodo, count: projectNotebook.length },
    { id: 'compare', label: 'Compare', icon: GitMerge },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="animate-in fade-in duration-300 max-w-5xl mx-auto h-full flex flex-col pb-12">
      <header className="mb-6">
        <Link href="/app/projects" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Projects
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-display font-bold">
              {isNew ? 'New Project' : project?.name}
            </h1>
            {!isNew && (
              <p className="text-sm text-muted-foreground mt-1">
                Created {format(new Date(project!.createdAt), 'MMM d, yyyy')}
              </p>
            )}
          </div>
          {isNew && (
            <button onClick={handleSave} className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2">
              <Save className="w-4 h-4" /> Create Project
            </button>
          )}
        </div>
      </header>

      {!isNew && (
        <div className="flex items-center gap-1 border-b border-border mb-6 overflow-x-auto pb-px">
          {tabs.map(t => (
            <Link 
              key={t.id} 
              href={`/app/projects/${project!.id}/${t.id}`}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.id 
                  ? 'border-primary text-foreground' 
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
              {t.count !== undefined && (
                <span className="ml-1.5 bg-background text-muted-foreground px-1.5 py-0.5 rounded text-xs border border-border">
                  {t.count}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}

      <div className="flex-1">
        {(isNew || tab === 'overview') && (
          <div className="space-y-6">
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-display font-semibold mb-4">Basics</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Project Name</label>
                  <input 
                    type="text" 
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" 
                    value={formData.name} 
                    onChange={e => setFormData({...formData, name: e.target.value})} 
                    placeholder="E.g. Biodegradable Packaging Pilot"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Discipline</label>
                  <input 
                    type="text" 
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" 
                    value={formData.discipline} 
                    onChange={e => setFormData({...formData, discipline: e.target.value})} 
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Abstract / Description</label>
                <textarea 
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[80px] focus:outline-none focus:ring-2 focus:ring-primary/50" 
                  value={formData.description} 
                  onChange={e => setFormData({...formData, description: e.target.value})} 
                />
              </div>
            </div>

            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-display font-semibold mb-4">Research Framing</h2>
              
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Primary Research Question</label>
                <input 
                  type="text" 
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" 
                  value={formData.research_question} 
                  onChange={e => setFormData({...formData, research_question: e.target.value})} 
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Objectives (one per line)</label>
                  <textarea 
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[120px] focus:outline-none focus:ring-2 focus:ring-primary/50" 
                    value={formData.objectives} 
                    onChange={e => setFormData({...formData, objectives: e.target.value})} 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Hypotheses (one per line)</label>
                  <textarea 
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[120px] focus:outline-none focus:ring-2 focus:ring-primary/50" 
                    value={formData.hypotheses} 
                    onChange={e => setFormData({...formData, hypotheses: e.target.value})} 
                  />
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <label className="text-sm font-medium text-foreground">Constraints / Rules (one per line)</label>
                <textarea 
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[100px] focus:outline-none focus:ring-2 focus:ring-primary/50" 
                  value={formData.constraints} 
                  onChange={e => setFormData({...formData, constraints: e.target.value})} 
                  placeholder="E.g. No hazardous materials allowed"
                />
              </div>

              <div className="space-y-2 pt-2">
                <label className="text-sm font-medium text-foreground">Human Decision Supported</label>
                <textarea 
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[80px] focus:outline-none focus:ring-2 focus:ring-primary/50" 
                  value={formData.human_decision_supported} 
                  onChange={e => setFormData({...formData, human_decision_supported: e.target.value})} 
                  placeholder="What actual decision will a human make based on this project's outputs?"
                />
              </div>
            </div>

            {!isNew && (
              <div className="flex justify-end">
                <button onClick={handleSave} className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2">
                  <Save className="w-4 h-4" /> Save Changes
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'meetings' && !isNew && (
          <div className="space-y-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-display font-semibold text-lg">Meeting Runs</h2>
              <Link href={`/app/meetings/new?project=${project?.id}`} className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2">
                <Plus className="w-4 h-4" /> New Meeting
              </Link>
            </div>
            
            {projectRuns.length === 0 ? (
              <div className="text-center py-16 border border-dashed rounded-xl bg-background/30">
                <Activity className="w-10 h-10 text-muted-foreground mx-auto mb-4 opacity-50" />
                <h3 className="font-medium text-lg mb-2">No runs in this project</h3>
                <p className="text-muted-foreground text-sm max-w-sm mx-auto">Start a new meeting to debate hypotheses, review literature, or design experiments.</p>
              </div>
            ) : (
              <div className="vls-reading-surface rounded-xl divide-y divide-border overflow-hidden">
                {projectRuns.map(run => (
                  <Link key={run.id} href={`/app/runs/${run.id}`} className="flex items-center p-4 hover:bg-background/50 transition-colors group">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`w-2 h-2 rounded-full ${
                          run.status === 'completed' ? 'bg-accent' :
                          run.status === 'running' ? 'bg-primary animate-pulse' :
                          'bg-muted-foreground'
                        }`} />
                        <span className="font-medium group-hover:text-primary transition-colors">{run.title}</span>
                      </div>
                      <div className="text-sm text-muted-foreground flex items-center gap-3">
                        <span className="capitalize">{run.meetingType}</span>
                        <span>•</span>
                        <span>{format(new Date(run.createdAt), 'MMM d, h:mm a')}</span>
                        {run.completedAt && (
                          <>
                            <span>•</span>
                            <span>{run.usage.wallSeconds}s</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground flex items-center gap-4">
                      <div className="text-right">
                        <div className="font-medium text-foreground">{run.usage.providerCalls}</div>
                        <div className="text-xs">Calls</div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Placeholders for other tabs for now, they are specified but less critical to wire fully in this exact view vs their own pages */}
        {tab === 'evidence' && !isNew && (
          <div className="vls-reading-surface p-8 text-center rounded-xl">
            <Database className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-50" />
            <h3 className="font-medium mb-1">Evidence Library</h3>
            <p className="text-sm text-muted-foreground mb-4">View and manage uploaded sources for this project.</p>
            <Link href="/app/evidence" className="text-primary hover:underline text-sm">Go to global Evidence Library</Link>
          </div>
        )}

        {tab === 'notebook' && !isNew && (
          <div className="vls-reading-surface p-8 text-center rounded-xl">
            <ListTodo className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-50" />
            <h3 className="font-medium mb-1">Notebook</h3>
            <p className="text-sm text-muted-foreground mb-4">Human notes, decisions, and tasks extracted from meetings.</p>
            {projectNotebook.map(n => (
               <div key={n.id} className="text-left border p-4 rounded-lg mt-4 bg-background">
                 <div className="text-xs text-primary font-bold uppercase tracking-wider mb-1">{n.kind}</div>
                 <div className="font-medium mb-2">{n.title}</div>
                 <div className="text-sm text-muted-foreground">{n.content}</div>
               </div>
            ))}
          </div>
        )}

        {tab === 'compare' && !isNew && (
          <div className="pt-2 -m-8">
             <ProjectCompare />
          </div>
        )}

        {tab === 'settings' && !isNew && (
          <div className="vls-reading-surface rounded-xl p-6 border space-y-6 max-w-3xl">
            <div>
              <h2 className="text-lg font-display font-semibold mb-2 text-destructive flex items-center gap-2">
                <ShieldAlert className="w-5 h-5" /> Danger Zone
              </h2>
              <div className="border border-destructive/30 bg-destructive/5 rounded-xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-foreground">Delete Project</h3>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md">
                    Permanently remove this project, its drafts, evidence, and notebook. Completed runs are retained globally.
                  </p>
                </div>
                <button 
                  onClick={handleDeleteProject}
                  className="bg-destructive text-destructive-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-destructive/90 transition-colors flex items-center gap-2 shrink-0"
                >
                  <Trash2 className="w-4 h-4" /> Delete Project
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
