import React, { useState, useEffect } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { launchRun, validateDraftForLaunch } from '@/demo/engine';
import { mutate, uid } from '@/demo/store';
import { 
  ChevronRight, ArrowLeft, Play, Settings, Users, BookOpen, Clock, AlertTriangle, ShieldCheck
} from 'lucide-react';
import type { MeetingDraft } from '@/demo/types';

const STEPS = ['Mode & Template', 'Agenda', 'Team', 'Evidence', 'Controls', 'Review'];

export default function Composer() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const workspace = useWorkspace();
  const params = new URLSearchParams(search);
  
  const templateSlug = params.get('template');
  const projectParam = params.get('project');
  const seedDraftParam = params.get('draft'); // for ?draft=draft_demo_seed

  const defaultDraftId = uid('draft');
  const [draftId] = useState(seedDraftParam || defaultDraftId);
  const [step, setStep] = useState(0);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Auto-init draft if needed
  useEffect(() => {
    const existing = workspace.drafts.find(d => d.id === draftId);
    if (!existing) {
      mutate(s => {
        const tpl = templateSlug ? s.templates.find(t => t.slug === templateSlug) : null;
        s.drafts.push({
          id: draftId,
          projectId: projectParam || s.projects[0]?.id || '',
          templateSlug: templateSlug || null,
          title: tpl ? `New ${tpl.name}` : 'New Meeting',
          meetingType: tpl ? (tpl.meeting_type as any) : 'team',
          agenda: tpl?.agenda_scaffold?.agenda || '',
          questions: tpl?.agenda_scaffold?.questions || [],
          rules: tpl?.agenda_scaffold?.rules || [],
          desiredOutput: tpl?.agenda_scaffold?.desired_output || '',
          humanDecision: '',
          agentSlugs: tpl ? tpl.suggested_agents.map(a => a.agent_slug) : [],
          leadSlug: tpl ? tpl.suggested_agents.find(a => a.role_type === 'lead')?.agent_slug || null : null,
          criticSlug: tpl ? tpl.suggested_agents.find(a => a.role_type === 'critic')?.agent_slug || null : null,
          rounds: tpl?.default_rounds || 2,
          temperature: 0.7,
          provider: 'demo',
          model: 'demo-research-v1',
          evidenceIds: [],
          pauseAfterRound: false,
          budgets: {
            max_provider_calls: 25,
            max_tool_calls: 10,
            max_wall_seconds: 900,
            max_cost_usd: 0
          },
          updatedAt: new Date().toISOString(),
          revision: 1
        });
      });
    }
  }, [draftId, workspace.drafts, templateSlug, projectParam]);

  const draft = workspace.drafts.find(d => d.id === draftId);

  if (!draft) return <div className="p-8 text-center">Loading composer...</div>;

  const updateDraft = (fn: (d: MeetingDraft) => void) => {
    mutate(s => {
      const d = s.drafts.find(x => x.id === draftId);
      if (d) {
        fn(d);
        d.updatedAt = new Date().toISOString();
        d.revision++;
      }
    });
  };

  // Launch validation: a run must have a project, a title, and a roster
  // compatible with the selected mode before it can be launched.
  const launchBlockers = validateDraftForLaunch(draft);
  const canLaunch = launchBlockers.length === 0;

  const handleLaunch = () => {
    if (!canLaunch) return;
    try {
      const runId = launchRun(draft);
      setLocation(`/app/runs/${runId}/live`);
    } catch (e: any) {
      setLaunchError(e.message || String(e));
    }
  };

  const getStepForBlocker = (b: string) => {
    if (b.toLowerCase().includes('project')) return 0;
    if (b.toLowerCase().includes('title')) return 1;
    if (b.toLowerCase().includes('agent') || b.toLowerCase().includes('lead') || b.toLowerCase().includes('critic') || b.toLowerCase().includes('roster')) return 2;
    return 0;
  };

  // Precompute est
  const specialists = Math.max(1, draft.agentSlugs.length - 1);
  const providerCalls = draft.meetingType === 'individual' ? draft.rounds * 2 + 1 : 1 + draft.rounds * specialists + 1;

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] animate-in fade-in duration-300 max-w-6xl mx-auto pb-4">
      {/* Header Wizard */}
      <div className="shrink-0 mb-6 border-b border-border pb-6">
        <button onClick={() => setLocation('/app/runs')} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-display font-bold">Meeting Composer</h1>
          <div className="hidden md:flex items-center gap-2 text-sm">
            {STEPS.map((s, i) => (
              <React.Fragment key={i}>
                <div className={`flex items-center gap-2 ${i === step ? 'text-primary font-semibold' : i < step ? 'text-foreground' : 'text-muted-foreground'}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-foreground text-background' : 'bg-background border border-border'}`}>
                    {i + 1}
                  </div>
                  {s}
                </div>
                {i < STEPS.length - 1 && <ChevronRight className="w-4 h-4 text-border" />}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-background/50 rounded-xl border border-border p-6 shadow-sm relative">
        {step === 0 && (
          <div className="max-w-2xl mx-auto space-y-8 py-8 animate-in slide-in-from-right-4">
            <div className="text-center">
              <h2 className="text-3xl font-display font-bold mb-2">Select a Meeting Mode</h2>
              <p className="text-muted-foreground">The mode defines the interaction pattern between agents.</p>
            </div>
            
            <div className="grid grid-cols-1 gap-4">
              <div 
                className={`p-6 rounded-xl cursor-pointer border-2 transition-all ${draft.meetingType === 'team' ? 'border-primary bg-primary/5' : 'border-transparent vls-glass hover:border-border'}`}
                onClick={() => updateDraft(d => d.meetingType = 'team')}
              >
                <h3 className="text-xl font-semibold mb-2">Team Council</h3>
                <p className="text-sm text-muted-foreground">Lead investigator + ordered specialists. Best for multidisciplinary synthesis and complex experimental design.</p>
              </div>
              <div 
                className={`p-6 rounded-xl cursor-pointer border-2 transition-all ${draft.meetingType === 'individual' ? 'border-primary bg-primary/5' : 'border-transparent vls-glass hover:border-border'}`}
                onClick={() => updateDraft(d => d.meetingType = 'individual')}
              >
                <h3 className="text-xl font-semibold mb-2">Expert & Critic</h3>
                <p className="text-sm text-muted-foreground">One expert alternates with a dedicated critic. Best for rigorous stress-testing of a specific hypothesis.</p>
              </div>
            </div>

            <div className="space-y-2 mt-8">
              <label className="text-sm font-medium">Project Context</label>
              <select 
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                value={draft.projectId}
                onChange={e => updateDraft(d => d.projectId = e.target.value)}
              >
                {workspace.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="max-w-3xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
            <h2 className="text-2xl font-display font-bold">Agenda & Objectives</h2>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Meeting Title</label>
                <input 
                  type="text" 
                  className="w-full bg-background border border-input rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  value={draft.title}
                  onChange={e => updateDraft(d => d.title = e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Primary Objective / Agenda</label>
                <textarea 
                  className="w-full bg-background border border-input rounded-md px-3 py-2 min-h-[100px] focus:outline-none focus:ring-2 focus:ring-primary"
                  value={draft.agenda}
                  onChange={e => updateDraft(d => d.agenda = e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Required Questions (one per line)</label>
                  <textarea 
                    className="w-full bg-background border border-input rounded-md px-3 py-2 min-h-[150px] focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                    value={draft.questions.join('\n')}
                    onChange={e => updateDraft(d => d.questions = e.target.value.split('\n').filter(Boolean))}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-warning">Constraints / Rules (one per line)</label>
                  <textarea 
                    className="w-full bg-background border border-warning/50 rounded-md px-3 py-2 min-h-[150px] focus:outline-none focus:ring-2 focus:ring-warning/50 text-sm"
                    value={draft.rules.join('\n')}
                    onChange={e => updateDraft(d => d.rules = e.target.value.split('\n').filter(Boolean))}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-secondary">Desired Output Format</label>
                <input 
                  type="text" 
                  className="w-full bg-background border border-secondary/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-secondary/50"
                  value={draft.desiredOutput}
                  onChange={e => updateDraft(d => d.desiredOutput = e.target.value)}
                  placeholder="e.g. A staged pilot design with explicit factors and analysis plan"
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="max-w-4xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-display font-bold">Team Assembly</h2>
              <span className="text-sm text-muted-foreground">{draft.agentSlugs.length} agents selected</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2 space-y-4">
                <div className="vls-glass p-4 rounded-xl border-l-4 border-l-primary">
                  <div className="text-sm font-semibold mb-3 uppercase tracking-wider text-muted-foreground flex justify-between">
                    <span>Meeting Roster (Speaking Order)</span>
                  </div>
                  <div className="space-y-2">
                    {draft.agentSlugs.map((slug, idx) => {
                      const agent = workspace.agents.find(a => a.slug === slug);
                      return (
                        <div key={idx} className="flex flex-col sm:flex-row sm:items-center justify-between bg-background p-3 rounded-lg border border-border group gap-3">
                          <div className="flex items-center gap-3">
                            <div className="w-6 h-6 rounded bg-primary/10 text-primary text-xs flex items-center justify-center font-mono">
                              {idx + 1}
                            </div>
                            <div className="font-medium text-sm">{agent?.title || slug}</div>
                            {slug === draft.leadSlug && <span className="text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded font-bold uppercase">Lead</span>}
                            {slug === draft.criticSlug && <span className="text-[10px] bg-warning/20 text-warning px-2 py-0.5 rounded font-bold uppercase">Critic</span>}
                          </div>
                          <div className="flex items-center gap-3 mt-3 sm:mt-0 sm:ml-auto">
                            <div className="flex flex-wrap sm:flex-nowrap gap-1.5">
                              {draft.meetingType === 'team' && (
                                <button
                                  onClick={() => updateDraft(d => d.leadSlug = d.leadSlug === slug ? null : slug)}
                                  className={`text-[10px] uppercase font-bold px-2 py-1 rounded transition-colors ${slug === draft.leadSlug ? 'bg-primary/20 text-primary border border-primary/50' : 'text-muted-foreground border border-border hover:bg-background/80'}`}
                                >
                                  {slug === draft.leadSlug ? 'Is Lead' : 'Set as Lead'}
                                </button>
                              )}
                              <button
                                onClick={() => updateDraft(d => d.criticSlug = d.criticSlug === slug ? null : slug)}
                                className={`text-[10px] uppercase font-bold px-2 py-1 rounded transition-colors ${slug === draft.criticSlug ? 'bg-warning/20 text-warning border border-warning/50' : 'text-muted-foreground border border-border hover:bg-background/80'}`}
                              >
                                {slug === draft.criticSlug ? 'Is Critic' : 'Set as Critic'}
                              </button>
                            </div>
                            <button 
                              className="text-xs text-destructive hover:underline ml-2 whitespace-nowrap"
                              onClick={() => updateDraft(d => {
                                d.agentSlugs = d.agentSlugs.filter((_, i) => i !== idx);
                                if (d.leadSlug === slug) d.leadSlug = null;
                                if (d.criticSlug === slug) d.criticSlug = null;
                              })}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {draft.agentSlugs.length === 0 && (
                      <div className="text-center py-6 text-muted-foreground text-sm border border-dashed rounded-lg">
                        Add agents from the library to build your team.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="vls-reading-surface rounded-xl p-4 border h-[500px] overflow-auto">
                <h3 className="font-semibold mb-4 flex items-center gap-2"><Users className="w-4 h-4" /> Agent Library</h3>
                <div className="space-y-2">
                  {workspace.agents.map(a => {
                    const isSelected = draft.agentSlugs.includes(a.slug);
                    return (
                      <div key={a.slug} className={`p-3 rounded-lg border text-sm transition-colors ${isSelected ? 'border-primary/50 bg-primary/5 opacity-50 cursor-not-allowed' : 'border-border bg-background cursor-pointer hover:border-primary/50'}`}
                           onClick={() => !isSelected && updateDraft(d => {
                             d.agentSlugs.push(a.slug);
                             if (d.meetingType === 'team' && d.agentSlugs.length === 1 && !d.leadSlug) {
                               d.leadSlug = a.slug;
                             }
                           })}>
                        <div className="font-medium mb-1">{a.title}</div>
                        <div className="text-xs text-muted-foreground line-clamp-2">{a.expertise}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="max-w-4xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
             <div className="flex items-center justify-between">
              <h2 className="text-2xl font-display font-bold">Evidence Context</h2>
              <span className="text-sm font-medium bg-primary/10 text-primary px-3 py-1 rounded-full">
                {draft.evidenceIds.length} sources attached
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {workspace.evidence.filter(e => e.projectId === draft.projectId || !draft.projectId).map(ev => {
                const selected = draft.evidenceIds.includes(ev.evidence_id);
                return (
                  <label key={ev.evidence_id} className={`flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${selected ? 'border-primary bg-primary/5' : 'border-border vls-glass hover:border-primary/30'}`}>
                    <input 
                      type="checkbox" 
                      className="mt-1 w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      checked={selected}
                      onChange={(e) => {
                        updateDraft(d => {
                          if (e.target.checked) d.evidenceIds.push(ev.evidence_id);
                          else d.evidenceIds = d.evidenceIds.filter(id => id !== ev.evidence_id);
                        })
                      }}
                    />
                    <div>
                      <div className="font-medium text-foreground mb-1">{ev.title}</div>
                      <div className="text-sm text-muted-foreground line-clamp-2">{ev.content}</div>
                    </div>
                  </label>
                )
              })}
              {workspace.evidence.length === 0 && (
                <div className="text-center py-12 vls-glass border-dashed rounded-xl text-muted-foreground">
                  No evidence available. Upload documents in the Evidence Library.
                </div>
              )}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="max-w-2xl mx-auto space-y-8 py-4 animate-in slide-in-from-right-4">
            <h2 className="text-2xl font-display font-bold mb-6">Execution Controls</h2>
            
            <div className="space-y-6">
              <div className="vls-reading-surface p-6 rounded-xl border space-y-4">
                <h3 className="font-semibold border-b border-border pb-2">Debate Parameters</h3>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Rounds</label>
                    <input 
                      type="number" min="1" max="10"
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={draft.rounds}
                      onChange={e => updateDraft(d => d.rounds = parseInt(e.target.value) || 1)}
                    />
                    <div className="text-xs text-muted-foreground">Full cycles through the speaking roster</div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Temperature</label>
                    <input 
                      type="number" step="0.1" min="0" max="2"
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={draft.temperature}
                      onChange={e => updateDraft(d => d.temperature = parseFloat(e.target.value) || 0.7)}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-3 mt-4">
                  <input 
                    type="checkbox" 
                    className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                    checked={draft.pauseAfterRound}
                    onChange={e => updateDraft(d => d.pauseAfterRound = e.target.checked)}
                  />
                  <span className="text-sm font-medium">Pause after each round for human intervention</span>
                </label>
              </div>

              <div className="vls-reading-surface p-6 rounded-xl border space-y-4 border-warning/30">
                <div className="border-b border-border pb-2">
                  <h3 className="font-semibold text-warning flex items-center gap-2">
                    <Settings className="w-4 h-4" /> Budgets & Limits
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">Limits are evaluated and enforced at safe checkpoints to prevent mid-thought termination. Set a limit to 0 for unlimited.</p>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="budget-provider-calls">Max Provider Calls</label>
                    <input
                      id="budget-provider-calls"
                      type="number"
                      min={0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={draft.budgets.max_provider_calls}
                      onChange={e => updateDraft(d => d.budgets.max_provider_calls = Math.max(0, parseInt(e.target.value, 10) >= 0 ? parseInt(e.target.value, 10) : 0))}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="budget-tool-calls">Max Tool Calls</label>
                    <input
                      id="budget-tool-calls"
                      type="number"
                      min={0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={draft.budgets.max_tool_calls}
                      onChange={e => updateDraft(d => d.budgets.max_tool_calls = Math.max(0, parseInt(e.target.value, 10) >= 0 ? parseInt(e.target.value, 10) : 0))}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="budget-wall-seconds">Wall Time (seconds)</label>
                    <input
                      id="budget-wall-seconds"
                      type="number"
                      min={0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={draft.budgets.max_wall_seconds}
                      onChange={e => updateDraft(d => d.budgets.max_wall_seconds = Math.max(0, parseInt(e.target.value, 10) >= 0 ? parseInt(e.target.value, 10) : 0))}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="budget-cost-usd">Max Cost (USD)</label>
                    <input
                      id="budget-cost-usd"
                      type="number"
                      min={0}
                      step={0.01}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={draft.budgets.max_cost_usd}
                      onChange={e => updateDraft(d => d.budgets.max_cost_usd = Math.max(0, parseFloat(e.target.value) >= 0 ? parseFloat(e.target.value) : 0))}
                    />
                    <p className="text-xs text-muted-foreground">Demo Provider runs cost $0; this limit applies once real providers are connected.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="max-w-3xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-display font-bold">Review & Launch</h2>
              <p className="text-muted-foreground mt-2">Verify parameters before initializing the simulation environment.</p>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="vls-glass p-5 rounded-xl space-y-4">
                <h3 className="font-semibold flex items-center gap-2 border-b border-border pb-2"><BookOpen className="w-4 h-4 text-primary" /> Setup</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Mode</span><span className="font-medium capitalize">{draft.meetingType}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Team Size</span><span className="font-medium">{draft.agentSlugs.length}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Evidence</span><span className="font-medium">{draft.evidenceIds.length} sources</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Rounds</span><span className="font-medium">{draft.rounds}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Provider</span><span className="font-medium capitalize">{draft.provider} ({draft.model})</span></div>
                </div>
              </div>
              
              <div className="vls-glass p-5 rounded-xl space-y-4">
                <h3 className="font-semibold flex items-center gap-2 border-b border-border pb-2"><Clock className="w-4 h-4 text-secondary" /> Estimates</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Provider Calls</span><span className="font-mono">~{providerCalls}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Tokens</span><span className="font-mono">~{(providerCalls * 650).toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Cost</span><span className="font-mono">$0.00 (Demo)</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Duration</span><span className="font-mono">~{Math.round(providerCalls * 6)}s</span></div>
                </div>
              </div>
            </div>

            <div className="bg-primary/5 border border-primary/20 p-5 rounded-xl flex gap-4">
              <ShieldCheck className="w-6 h-6 text-primary shrink-0" />
              <div>
                <h4 className="font-semibold text-sm mb-1 text-primary">Simulation Notice</h4>
                <p className="text-xs text-muted-foreground">
                  This run will execute using the deterministic Demo Provider. No real API calls will be made, and the output will follow the seeded scenario regardless of parameters chosen. The result will be labeled "Simulation — Demo Provider" permanently.
                </p>
              </div>
            </div>

            {launchBlockers.length > 0 && (
              <div className="vls-glass p-5 rounded-xl border border-warning/30 bg-warning/5 space-y-4">
                <h3 className="font-semibold text-warning flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> Cannot Launch Yet
                </h3>
                <ul className="list-disc pl-5 text-sm text-warning/80 space-y-1.5">
                  {launchBlockers.map((b, i) => (
                    <li key={i}>
                      <button onClick={() => setStep(getStepForBlocker(b))} className="hover:underline text-left">{b}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            
            {launchError && (
              <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-destructive text-sm font-medium">
                Launch failed: {launchError}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 mt-6 pt-4 border-t border-border flex justify-between items-center bg-background z-10 relative">
        <button 
          className="px-6 py-2.5 rounded-lg font-medium text-sm border border-border hover:bg-background/50 transition-colors disabled:opacity-50"
          onClick={() => setStep(s => Math.max(0, s - 1))}
          disabled={step === 0}
        >
          Previous
        </button>
        {step < STEPS.length - 1 ? (
          <button 
            className="px-6 py-2.5 bg-foreground text-background rounded-lg font-medium text-sm hover:bg-foreground/90 transition-colors"
            onClick={() => setStep(s => Math.min(STEPS.length - 1, s + 1))}
          >
            Continue
          </button>
        ) : (
          <div className="flex items-center gap-4">
            {!canLaunch && (
              <p className="text-xs text-warning max-w-xs text-right" role="status">
                {launchBlockers[0]}
              </p>
            )}
            <button
              className="px-8 py-2.5 bg-primary text-primary-foreground rounded-lg font-bold text-sm hover:bg-primary/90 transition-transform active:scale-[0.98] shadow-lg shadow-primary/20 flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
              onClick={handleLaunch}
              disabled={!canLaunch}
            >
              <Play className="w-4 h-4 fill-current" /> Launch Meeting
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
