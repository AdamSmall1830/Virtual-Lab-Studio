import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  ArrowLeft, Users, Database, Settings, Sparkles, Plus, X, Loader2,
  ChevronDown, ChevronRight, Play, AlertTriangle, Check, BookOpen, Layers
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useSession } from '@/api/session';
import {
  useProjects,
  useTemplates,
  useAgents,
  useProviders,
  useProjectEvidence,
  getProjectsQueryKey,
  getProjectEvidenceQueryKey,
  getListTemplatesApiV1WorkspacesWorkspaceIdTemplatesGetQueryKey as getTemplatesQueryKey,
  getListAgentsApiV1WorkspacesWorkspaceIdAgentsGetQueryKey as getAgentsQueryKey,
  getListProvidersApiV1WorkspacesWorkspaceIdProvidersGetQueryKey as getProvidersQueryKey,
  useCreateDraft,
  useValidateDraft,
  useLaunchDraft,
  type AgentProfileOut,
  type ProviderConfigOut,
  type MeetingDraftIn,
  type DraftAgentIn,
  type DraftAgentInRoleType,
  type ValidationEstimateOut,
  type EvidenceSourceOut,
  type TemplateProfileOut,
} from '@/api';

type MeetingType = 'team' | 'individual';

interface Participant {
  agent: AgentProfileOut;
  roleType: DraftAgentInRoleType;
}

function splitLines(v: string): string[] {
  return v.split('\n').map((s) => s.trim()).filter(Boolean);
}

function errMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

function TemplateDef(t: TemplateProfileOut): Record<string, unknown> {
  return (t.latest_version?.definition_json as Record<string, unknown>) ?? {};
}

export default function Composer() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { workspaceId } = useSession();
  const searchParams = new URLSearchParams(search);
  const initialProject = searchParams.get('project');
  const initialTemplate = searchParams.get('template');

  const enabled = Boolean(workspaceId);
  const wsId = workspaceId ?? '';
  
  const projectsQuery = useProjects(wsId, {
    query: { queryKey: getProjectsQueryKey(wsId), enabled },
  });
  const templatesQuery = useTemplates(wsId, {
    query: { queryKey: getTemplatesQueryKey(wsId), enabled },
  });
  const agentsQuery = useAgents(wsId, {
    query: { queryKey: getAgentsQueryKey(wsId), enabled },
  });
  const providersQuery = useProviders(wsId, {
    query: { queryKey: getProvidersQueryKey(wsId), enabled },
  });

  const projects = projectsQuery.data ?? [];
  const templates = templatesQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const providers: ProviderConfigOut[] = providersQuery.data ?? [];

  // ---- draft state ----
  const [projectId, setProjectId] = useState<string>('');
  const [templateId, setTemplateId] = useState<string>('');
  const [title, setTitle] = useState('New Research Session');
  const [meetingType, setMeetingType] = useState<MeetingType>('team');
  const [agenda, setAgenda] = useState('');
  const [questions, setQuestions] = useState('');
  const [rules, setRules] = useState('');
  const [rounds, setRounds] = useState(2);
  const [temperature, setTemperature] = useState(0.2);
  const [maxProviderCalls, setMaxProviderCalls] = useState(0);
  const [maxCostUsd, setMaxCostUsd] = useState(0);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [prefilledTemplate, setPrefilledTemplate] = useState(false);

  // ---- UI state ----
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAgentLibrary, setShowAgentLibrary] = useState(false);

  // Default project selection once projects load.
  useEffect(() => {
    if (projectId || projects.length === 0) return;
    const preferred =
      (initialProject && projects.find((p) => p.id === initialProject)?.id) || projects[0].id;
    setProjectId(preferred);
  }, [projectId, projects, initialProject]);
  
  const resolvedProjectId = projectId || initialProject || projects[0]?.id || '';

  // Provider + model selection for the whole session team. Defaults to the
  // Demo Provider; any enabled real provider with enabled models is selectable.
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const selectableProviders = useMemo(
    () => providers.filter((p) => p.is_enabled && (p.models ?? []).some((m) => m.is_enabled)),
    [providers],
  );
  useEffect(() => {
    if (providerId || selectableProviders.length === 0) return;
    const demo = selectableProviders.find((p) => p.provider_type === 'demo');
    const pick = demo ?? selectableProviders[0];
    setProviderId(pick.id);
    setModelId((pick.models ?? []).find((m) => m.is_enabled)?.id ?? '');
  }, [providerId, selectableProviders]);
  const selectedProvider = useMemo(
    () => selectableProviders.find((p) => p.id === providerId),
    [selectableProviders, providerId],
  );
  const selectedModel = useMemo(
    () => (selectedProvider?.models ?? []).find((m) => m.id === modelId && m.is_enabled),
    [selectedProvider, modelId],
  );
  const chooseProvider = (id: string) => {
    setProviderId(id);
    const p = selectableProviders.find((x) => x.id === id);
    setModelId((p?.models ?? []).find((m) => m.is_enabled)?.id ?? '');
  };

  const evidenceQuery = useProjectEvidence(resolvedProjectId, {
    query: { queryKey: getProjectEvidenceQueryKey(resolvedProjectId), enabled: Boolean(resolvedProjectId) && enabled },
  });
  const evidence: EvidenceSourceOut[] = evidenceQuery.data ?? [];

  const createDraft = useCreateDraft();
  const validateDraft = useValidateDraft();
  const launchDraft = useLaunchDraft();

  const [estimate, setEstimate] = useState<ValidationEstimateOut | null>(null);
  const [validatedDraftId, setValidatedDraftId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const busy = createDraft.isPending || validateDraft.isPending || launchDraft.isPending;

  // ---- template application ----
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    setPrefilledTemplate(false);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    
    const def = TemplateDef(t);
    const mt = (def.meeting_type as MeetingType) ?? (t.latest_version?.meeting_type as MeetingType);
    if (mt === 'team' || mt === 'individual') setMeetingType(mt);
    if (typeof def.agenda_template === 'string') setAgenda(def.agenda_template);
    else if (typeof def.agenda === 'string') setAgenda(def.agenda);
    if (Array.isArray(def.questions)) setQuestions((def.questions as string[]).join('\n'));
    if (Array.isArray(def.rules)) setRules((def.rules as string[]).join('\n'));
    if (typeof def.default_rounds === 'number') setRounds(def.default_rounds);
    if (typeof def.default_temperature === 'number') setTemperature(def.default_temperature);
    setTitle(`New ${t.name}`);

    // Prefill participants from suggested_agents once agents are available.
    const suggested = (def.suggested_agents as { agent_slug: string; role_type: string }[]) ?? [];
    if (suggested.length && agents.length) {
      const next: Participant[] = [];
      for (const s of suggested) {
        const agent = agents.find((a) => a.slug === s.agent_slug);
        if (!agent) continue;
        const rt = s.role_type as DraftAgentInRoleType;
        if (mt === 'team' && (rt === 'lead' || rt === 'member')) next.push({ agent, roleType: rt });
        else if (mt === 'individual' && (rt === 'expert' || rt === 'critic')) {
          next.push({ agent, roleType: rt });
        } else if (mt === 'team') next.push({ agent, roleType: 'member' });
      }
      setParticipants(next);
      setPrefilledTemplate(true);
    }
  };

  // Apply ?template= from URL once templates + agents are loaded (once).
  const [appliedUrlTemplate, setAppliedUrlTemplate] = useState(false);
  useEffect(() => {
    if (appliedUrlTemplate || !initialTemplate || templateId || templates.length === 0) return;
    const match = templates.find((t) => t.slug === initialTemplate || t.id === initialTemplate);
    if (match) {
      applyTemplate(match.id);
      setAppliedUrlTemplate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedUrlTemplate, initialTemplate, templateId, templates, agents]);

  // Set default team once agents are loaded, if empty and not prefilled
  const [hasSetDefaultTeam, setHasSetDefaultTeam] = useState(false);
  useEffect(() => {
    if (agents.length > 0 && participants.length === 0 && !hasSetDefaultTeam && !prefilledTemplate && !initialTemplate) {
      const validAgents = agents.filter(a => a.latest_version);
      const defaultParticipants: Participant[] = [];
      
      if (meetingType === 'team') {
        if (validAgents[0]) defaultParticipants.push({ agent: validAgents[0], roleType: 'lead' });
        if (validAgents[1]) defaultParticipants.push({ agent: validAgents[1], roleType: 'member' });
      } else {
        if (validAgents[0]) defaultParticipants.push({ agent: validAgents[0], roleType: 'expert' });
        if (validAgents[1]) defaultParticipants.push({ agent: validAgents[1], roleType: 'critic' });
      }
      setParticipants(defaultParticipants);
      setHasSetDefaultTeam(true);
    }
  }, [agents, participants.length, hasSetDefaultTeam, meetingType, prefilledTemplate, initialTemplate]);

  // Clear estimate if any configuration changes
  useEffect(() => {
    setEstimate(null);
    setValidatedDraftId(null);
    setLaunchError(null);
  }, [title, meetingType, agenda, questions, rules, rounds, temperature, maxProviderCalls, maxCostUsd, participants, evidenceIds, providerId, modelId]);

  // ---- roster helpers ----
  const handleMeetingTypeChange = (type: MeetingType) => {
    if (type === meetingType) return;
    setMeetingType(type);
    
    if (type === 'individual') {
       const newP = [...participants].slice(0, 2);
       if (newP[0]) newP[0].roleType = 'expert';
       if (newP[1]) newP[1].roleType = 'critic';
       setParticipants(newP);
    } else {
       const newP = [...participants];
       if (newP.length > 0) newP[0].roleType = 'lead';
       for (let i = 1; i < newP.length; i++) {
         newP[i].roleType = 'member';
       }
       setParticipants(newP);
    }
  };

  const addParticipant = (agent: AgentProfileOut) => {
    if (participants.some((p) => p.agent.id === agent.id)) return;
    const defaultRole: DraftAgentInRoleType =
      meetingType === 'team' ? 'member' : participants.some((p) => p.roleType === 'expert') ? 'critic' : 'expert';
    setParticipants((prev) => [...prev, { agent, roleType: defaultRole }]);
  };

  const removeParticipant = (agentId: string) => {
    setParticipants((prev) => prev.filter((p) => p.agent.id !== agentId));
  };

  const setRole = (agentId: string, roleType: DraftAgentInRoleType) => {
    setParticipants((prev) =>
      prev.map((p) => (p.agent.id === agentId ? { ...p, roleType } : p)),
    );
  };

  const toggleEvidence = (id: string) => {
    setEvidenceIds(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // ---- client-side role validation ----
  const roleBlockers = useMemo(() => {
    const b: string[] = [];
    if (!resolvedProjectId) b.push('Select a project.');
    if (!title.trim()) b.push('Provide a session title.');
    if (!agenda.trim()) b.push('State your research question or agenda.');
    if (!selectedProvider || !selectedModel) b.push('Select an enabled model provider and model.');
    const roles = participants.map((p) => p.roleType);
    if (meetingType === 'team') {
      if (roles.filter((r) => r === 'lead').length !== 1) b.push('A team council needs exactly one lead investigator.');
      if (roles.filter((r) => r === 'member').length < 1) b.push('A team council needs at least one specialist.');
      if (roles.some((r) => r === 'expert' || r === 'critic')) {
        b.push('Team councils only use lead and specialist roles.');
      }
    } else {
      if (roles.filter((r) => r === 'expert').length !== 1) b.push('An individual session needs exactly one expert.');
      if (roles.filter((r) => r === 'critic').length !== 1) b.push('An individual session needs exactly one critic.');
      if (roles.some((r) => r === 'lead' || r === 'member')) {
        b.push('Individual sessions only use expert and critic roles.');
      }
    }
    if (rounds < 1 || rounds > 12) b.push('Rounds must be between 1 and 12.');
    return b;
  }, [resolvedProjectId, title, agenda, selectedProvider, selectedModel, participants, meetingType, rounds]);

  const canLaunch = roleBlockers.length === 0;

  const buildDraft = (): MeetingDraftIn => {
    const budget: Record<string, number> = {};
    if (maxProviderCalls > 0) budget.max_provider_calls = maxProviderCalls;
    if (maxCostUsd > 0) budget.max_cost_usd = maxCostUsd;
    const agentsIn: DraftAgentIn[] = participants.map((p, idx) => ({
      position: idx,
      role_type: p.roleType,
      agent_version_id: p.agent.latest_version?.id ?? '',
      provider_config_id: selectedProvider!.id,
      provider_model_id: selectedModel!.id,
      temperature_override: null,
    }));
    return {
      title: title.trim(),
      meeting_type: meetingType,
      agenda: agenda.trim(),
      questions: splitLines(questions),
      rules: splitLines(rules),
      contexts: [],
      rounds,
      default_temperature: temperature,
      budget,
      agents: agentsIn,
      template_version_id: templates.find((t) => t.id === templateId)?.latest_version?.id ?? null,
      evidence_source_ids: evidenceIds,
    };
  };

  const runValidation = async () => {
    setLaunchError(null);
    setEstimate(null);
    setValidatedDraftId(null);
    if (!canLaunch) return;
    try {
      const draft = await createDraft.mutateAsync({
        projectId: resolvedProjectId,
        data: buildDraft(),
      });
      const est = await validateDraft.mutateAsync({ draftId: draft.id });
      setEstimate(est);
      setValidatedDraftId(draft.id);
    } catch (err) {
      setLaunchError(errMessage(err, 'Failed to prepare the session.'));
    }
  };

  const handleLaunch = async () => {
    setLaunchError(null);
    if (!canLaunch) return;
    try {
      let targetDraftId = validatedDraftId;
      
      if (!targetDraftId) {
        const draft = await createDraft.mutateAsync({
          projectId: resolvedProjectId,
          data: buildDraft(),
        });
        const est = await validateDraft.mutateAsync({ draftId: draft.id });
        if (!est.valid) {
          setLaunchError('The session failed server validation. Review the configuration.');
          return;
        }
        targetDraftId = draft.id;
      }

      const launched = await launchDraft.mutateAsync({ draftId: targetDraftId });
      toast({ title: 'Session launched', description: 'The research session is starting.' });
      setLocation(`/app/runs/${launched.run_id}/live`);
    } catch (err) {
      setLaunchError(errMessage(err, 'Launch failed.'));
    }
  };

  const coreLoading = projectsQuery.isLoading || templatesQuery.isLoading || agentsQuery.isLoading || providersQuery.isLoading;
  const coreError = projectsQuery.isError || templatesQuery.isError || agentsQuery.isError || providersQuery.isError;

  if (coreLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm">Initializing composer…</p>
      </div>
    );
  }

  if (coreError) {
    return (
      <div className="max-w-md mx-auto mt-24 vls-glass rounded-2xl p-10 text-center border border-destructive/30 bg-destructive/5">
        <AlertTriangle className="w-10 h-10 text-destructive mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-2">Could not load workspace data</h2>
        <p className="text-sm text-muted-foreground mb-6">
          We couldn't load projects, agents, or providers. Please try again.
        </p>
        <button
          onClick={() => {
            projectsQuery.refetch();
            templatesQuery.refetch();
            agentsQuery.refetch();
            providersQuery.refetch();
          }}
          className="bg-foreground text-background px-6 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/90 transition-colors"
        >
          <Loader2 className="w-4 h-4" /> Retry Connection
        </button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="max-w-md mx-auto mt-24 vls-glass rounded-2xl p-10 text-center border-dashed">
        <div className="w-16 h-16 bg-muted/20 rounded-full flex items-center justify-center mx-auto mb-6">
          <Users className="w-8 h-8 text-muted-foreground opacity-60" />
        </div>
        <h2 className="text-xl font-display font-semibold mb-3">No projects found</h2>
        <p className="text-sm text-muted-foreground mb-8">
          Create a project to contain your research sessions.
        </p>
        <button
          onClick={() => setLocation('/app/projects')}
          className="bg-foreground text-background px-6 py-2.5 rounded-xl text-sm font-semibold hover:bg-foreground/90 transition-colors shadow-sm"
        >
          Go to Projects
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] animate-in fade-in duration-500 max-w-4xl mx-auto">
      
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between pb-6 pt-2">
        <button
          onClick={() => setLocation('/app/runs')}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Runs
        </button>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground font-medium">Project:</span>
          <select
            className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground font-semibold shadow-sm cursor-pointer"
            value={resolvedProjectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setEvidenceIds([]);
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Scrolling Area */}
      <div className="flex-1 overflow-auto bg-background/40 backdrop-blur-md rounded-t-3xl border border-border border-b-0 shadow-sm relative">
        <div className="p-8 sm:p-12 space-y-16 max-w-3xl mx-auto">
          
          {/* Block 1: Research Question */}
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <input 
              type="text"
              className="w-full bg-transparent border-none text-3xl sm:text-4xl font-display font-bold focus:outline-none placeholder:text-muted-foreground/30 mb-8 p-0 text-foreground"
              placeholder="Research Session Title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              data-testid="input-title"
            />
            
            <div className="vls-glass rounded-2xl p-1 relative group focus-within:ring-2 focus-within:ring-primary/50 focus-within:bg-primary/5 transition-all duration-300">
               <textarea
                 className="w-full min-h-[160px] bg-transparent p-5 text-lg resize-y focus:outline-none placeholder:text-muted-foreground/50 text-foreground"
                 placeholder="What is your research question? Be specific about hypotheses, constraints, and desired outcomes..."
                 value={agenda}
                 onChange={(e) => setAgenda(e.target.value)}
                 data-testid="input-agenda"
               />
               <div className="absolute top-5 right-5 text-muted-foreground/30 pointer-events-none transition-colors group-focus-within:text-primary/50">
                 <Sparkles className="w-6 h-6" />
               </div>
            </div>
          </div>

          {/* Block 2: Team Assembly */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-6 gap-4">
              <div>
                <h2 className="text-xl font-display font-bold flex items-center gap-2 text-foreground mb-2">
                  <Users className="w-5 h-5 text-primary" />
                  Research Team
                </h2>
                <p className="text-sm text-muted-foreground max-w-md">
                  {meetingType === 'team' 
                    ? 'A lead investigator synthesizes insights from ordered specialists. Best for complex, multi-disciplinary research.' 
                    : 'An expert iterates on the problem while a critic actively tries to find flaws. Best for rigorous stress-testing.'}
                </p>
              </div>
              
              <div className="flex bg-background p-1.5 rounded-xl border border-border shadow-sm w-fit flex-shrink-0">
                <button 
                  className={`px-4 py-2 text-sm rounded-lg transition-all ${meetingType === 'team' ? 'bg-primary/15 text-primary font-bold shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50 font-medium'}`}
                  onClick={() => handleMeetingTypeChange('team')}
                >
                  Team Council
                </button>
                <button 
                  className={`px-4 py-2 text-sm rounded-lg transition-all ${meetingType === 'individual' ? 'bg-primary/15 text-primary font-bold shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50 font-medium'}`}
                  onClick={() => handleMeetingTypeChange('individual')}
                >
                  Expert & Critic
                </button>
              </div>
            </div>
            
            {participants.length === 0 ? (
              <button 
                onClick={() => setShowAgentLibrary(true)}
                className="w-full vls-glass rounded-2xl p-10 flex flex-col items-center justify-center gap-4 text-muted-foreground hover:text-primary hover:border-primary/50 transition-all border-dashed"
              >
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                  <Plus className="w-7 h-7" />
                </div>
                <div className="text-center">
                  <div className="font-bold text-foreground text-lg mb-1">Assemble your team</div>
                  <div className="text-sm">Select agents from the library to participate in this session.</div>
                </div>
              </button>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {participants.map((p) => (
                  <div key={p.agent.id} className="vls-glass rounded-xl p-5 flex flex-col relative group hover:border-primary/30 transition-colors">
                    <button 
                      onClick={() => removeParticipant(p.agent.id)} 
                      className="absolute top-3 right-3 p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md opacity-0 group-hover:opacity-100 transition-all"
                      title="Remove from team"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    
                    <div className="flex items-start gap-4 mb-5 pr-6">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/20 to-secondary/20 flex items-center justify-center flex-shrink-0 border border-primary/20">
                        <span className="text-primary font-display font-bold text-xl">{p.agent.title.charAt(0)}</span>
                      </div>
                      <div className="min-w-0 pt-0.5">
                        <div className="font-bold text-foreground leading-tight truncate">{p.agent.title}</div>
                        <div className="text-xs text-muted-foreground line-clamp-1 mt-1 font-medium">{p.agent.latest_version?.expertise || 'General intelligence'}</div>
                      </div>
                    </div>
                    
                    <div className="mt-auto pt-4 border-t border-border/50">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold">Assigned Role</div>
                      <select 
                        value={p.roleType}
                        onChange={(e) => setRole(p.agent.id, e.target.value as DraftAgentInRoleType)}
                        className="w-full text-sm bg-primary/10 border border-primary/20 rounded-lg px-3 py-2 text-primary font-bold focus:outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer appearance-none shadow-sm"
                      >
                        {meetingType === 'team' ? (
                          <>
                            <option value="lead">Lead Investigator</option>
                            <option value="member">Specialist</option>
                          </>
                        ) : (
                          <>
                            <option value="expert">Expert</option>
                            <option value="critic">Critic</option>
                          </>
                        )}
                      </select>
                    </div>
                  </div>
                ))}
                
                <button 
                  onClick={() => setShowAgentLibrary(true)}
                  className="vls-glass rounded-xl p-5 flex flex-col items-center justify-center gap-3 text-muted-foreground hover:text-primary hover:border-primary/50 transition-all border-dashed min-h-[160px]"
                >
                  <div className="w-10 h-10 rounded-full bg-muted/30 flex items-center justify-center">
                    <Plus className="w-5 h-5" />
                  </div>
                  <span className="text-sm font-semibold">Add Researcher</span>
                </button>
              </div>
            )}
          </div>

          {/* Block 3: Knowledge Sources */}
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-display font-bold flex items-center gap-2 text-foreground">
                <Database className="w-5 h-5 text-primary" />
                Knowledge Sources
              </h2>
              <span className="text-sm font-semibold bg-primary/10 text-primary px-3 py-1 rounded-full">
                {evidenceIds.length} attached
              </span>
            </div>
            
            {evidence.length === 0 ? (
              <div className="vls-glass rounded-2xl p-10 text-center text-sm text-muted-foreground border-dashed">
                <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <div className="font-medium text-base mb-1 text-foreground">No knowledge sources available</div>
                <div>Upload documents to this project to attach them here.</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto pr-2">
                {evidence.map(ev => {
                  const isAttached = evidenceIds.includes(ev.id);
                  return (
                    <div 
                      key={ev.id} 
                      onClick={() => toggleEvidence(ev.id)}
                      className={`p-4 rounded-xl border cursor-pointer flex items-start gap-4 transition-all duration-200 ${
                        isAttached 
                          ? 'bg-primary/10 border-primary/50 shadow-[inset_0_0_20px_rgba(var(--vls-primary),0.05)]' 
                          : 'vls-glass hover:border-primary/50 hover:bg-muted/10'
                      }`}
                    >
                      <div className={`mt-0.5 w-5 h-5 rounded-[4px] border flex items-center justify-center flex-shrink-0 transition-colors ${isAttached ? 'bg-primary border-primary text-primary-foreground' : 'border-border/80 bg-background'}`}>
                         {isAttached && <Check className="w-3.5 h-3.5" />}
                      </div>
                      <div className="min-w-0 pt-0.5">
                        <div className={`text-sm font-bold line-clamp-1 ${isAttached ? 'text-primary' : 'text-foreground'}`}>
                          {ev.title}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-1.5 uppercase tracking-wider font-bold">
                          {ev.source_type}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Block 4: Advanced Controls */}
          <div className="pt-8 border-t border-border/60">
            <button 
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-3 text-lg font-display font-bold text-foreground hover:text-primary transition-colors group"
            >
              <Settings className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
              Advanced Controls
              <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform duration-300 ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>
            
            {showAdvanced && (
              <div className="mt-8 space-y-10 animate-in slide-in-from-top-4 fade-in duration-300">
                
                {/* Templates */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground flex items-center gap-2">
                    <Layers className="w-4 h-4 text-primary" />
                    Session Template
                  </label>
                  <p className="text-sm text-muted-foreground mb-3 max-w-2xl">Apply a pre-configured template to set the agenda, questions, rules, and team automatically.</p>
                  <select
                    className="w-full bg-background border border-border rounded-xl px-4 py-3.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground cursor-pointer shadow-sm"
                    value={templateId}
                    onChange={(e) => {
                      if (e.target.value) applyTemplate(e.target.value);
                      else { setTemplateId(''); setPrefilledTemplate(false); }
                    }}
                  >
                    <option value="">No Template (Blank Session)</option>
                    {templates
                      .filter((t) => {
                        const mt = (TemplateDef(t).meeting_type as string) ?? t.latest_version?.meeting_type;
                        return mt === meetingType;
                      })
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-foreground">Specific Questions to Address</label>
                    <textarea
                      className="w-full bg-background border border-border rounded-xl px-4 py-4 min-h-[140px] text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y shadow-sm"
                      placeholder="One question per line..."
                      value={questions}
                      onChange={(e) => setQuestions(e.target.value)}
                    />
                  </div>
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-warning">Rules & Constraints</label>
                    <textarea
                      className="w-full bg-warning/5 border border-warning/30 rounded-xl px-4 py-4 min-h-[140px] text-sm focus:outline-none focus:ring-2 focus:ring-warning/50 resize-y shadow-sm"
                      placeholder="One rule per line..."
                      value={rules}
                      onChange={(e) => setRules(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-6 border-t border-border/60">
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-foreground">Model Provider</label>
                    <select
                      className="w-full bg-background border border-border rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground cursor-pointer shadow-sm"
                      value={providerId}
                      onChange={(e) => chooseProvider(e.target.value)}
                      data-testid="select-provider"
                    >
                      {selectableProviders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.provider_type === 'demo' ? ' (Simulation)' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {selectedProvider?.provider_type === 'demo'
                        ? 'Deterministic simulation — free, no external calls, truthfully labeled.'
                        : 'Real model calls with recorded usage, cost, and provenance.'}
                    </p>
                  </div>
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-foreground">Model</label>
                    <select
                      className="w-full bg-background border border-border rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground cursor-pointer shadow-sm"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      data-testid="select-model"
                    >
                      {(selectedProvider?.models ?? []).filter((m) => m.is_enabled).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                          {m.input_per_million != null && m.output_per_million != null
                            ? ` — $${m.input_per_million}/$${m.output_per_million} per 1M`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 pt-6 border-t border-border/60">
                  <div className="space-y-4">
                    <label className="text-sm font-bold text-foreground flex justify-between">
                      Discussion Rounds <span className="text-primary">{rounds}</span>
                    </label>
                    <input 
                      type="range" 
                      min="1" max="12" step="1"
                      value={rounds}
                      onChange={e => setRounds(parseInt(e.target.value))}
                      className="w-full accent-primary cursor-pointer"
                    />
                  </div>
                  <div className="space-y-4">
                    <label className="text-sm font-bold text-foreground flex justify-between">
                      Temperature <span className="text-primary">{temperature}</span>
                    </label>
                    <input 
                      type="range" 
                      min="0" max="1" step="0.1"
                      value={temperature}
                      onChange={e => setTemperature(parseFloat(e.target.value))}
                      className="w-full accent-primary cursor-pointer"
                    />
                  </div>
                  <div className="space-y-4">
                    <label className="text-sm font-bold text-foreground">Budget Limits (Optional)</label>
                    <div className="flex gap-3">
                      <input 
                        type="number" 
                        placeholder="Max Calls"
                        className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-medium"
                        value={maxProviderCalls || ''}
                        onChange={e => setMaxProviderCalls(parseInt(e.target.value) || 0)}
                      />
                      <input 
                        type="number" 
                        placeholder="Max USD"
                        className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-medium"
                        value={maxCostUsd || ''}
                        onChange={e => setMaxCostUsd(parseFloat(e.target.value) || 0)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Bar Content */}
      <div className="shrink-0 bg-background border border-border border-t-0 rounded-b-3xl shadow-xl z-10 transition-all duration-500 overflow-hidden">
        {launchError && (
          <div className="bg-destructive text-destructive-foreground px-6 py-3 text-sm font-bold flex items-center justify-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            {launchError}
          </div>
        )}

        {estimate ? (
          <div className="p-6 sm:p-8 bg-vls-surface-strong">
            <div className="flex flex-col md:flex-row items-start md:items-center gap-6 justify-between max-w-3xl mx-auto">
              <div className="flex items-start gap-5">
                <div className="w-14 h-14 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 border border-primary/30 shadow-[0_0_20px_rgba(var(--vls-primary),0.2)]">
                  <Check className="w-7 h-7 text-primary" />
                </div>
                <div>
                  <h3 className="text-2xl font-display font-bold mb-1.5 text-foreground">Session Ready for Launch</h3>
                  <p className="text-muted-foreground mb-5 text-sm sm:text-base leading-relaxed">
                    <strong className="text-foreground">{participants.length} researchers</strong> will deliberate for <strong className="text-foreground">{rounds} rounds</strong>, concluding with a synthesized final report.
                  </p>
                  <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm bg-background/60 p-3 rounded-xl border border-border inline-flex shadow-inner">
                     <div className="flex flex-col">
                       <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-bold mb-0.5">Est. Calls</span>
                       <span className="font-bold text-foreground text-base">{estimate.max_calls ?? 'Unknown'}</span>
                     </div>
                     <div className="flex flex-col">
                       <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-bold mb-0.5">Est. Cost</span>
                       <span className="font-bold text-foreground text-base" data-testid="text-est-cost">
                         {estimate.estimated_cost_usd != null
                           ? `$${estimate.estimated_cost_usd.toFixed(estimate.estimated_cost_usd > 0 && estimate.estimated_cost_usd < 0.01 ? 4 : 2)}${estimate.pricing_complete === false ? ' (partial pricing)' : ''}`
                           : 'N/A'}
                       </span>
                     </div>
                  </div>
                </div>
              </div>
              
              <div className="flex flex-col gap-3 min-w-[220px] w-full md:w-auto mt-2 md:mt-0">
                 <button 
                   onClick={handleLaunch}
                   disabled={busy}
                   className="w-full bg-primary text-primary-foreground px-8 py-4 rounded-xl font-bold text-lg hover:bg-primary/90 transition-all flex items-center justify-center gap-3 shadow-[0_0_40px_-10px_rgba(var(--vls-primary),0.6)] hover:shadow-[0_0_50px_-5px_rgba(var(--vls-primary),0.8)] disabled:opacity-50 disabled:cursor-not-allowed"
                   data-testid="launch-button"
                 >
                   {launchDraft.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                   Launch Session
                 </button>
                 <button 
                   onClick={() => setEstimate(null)}
                   className="w-full text-sm text-muted-foreground hover:text-foreground py-2 font-bold transition-colors"
                 >
                   Make adjustments
                 </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-5 sm:p-7 bg-background/80 flex flex-col sm:flex-row items-center justify-between gap-4 max-w-3xl mx-auto w-full">
             <div className="flex-1 text-center sm:text-left">
               {roleBlockers.length > 0 ? (
                 <div className="text-sm text-warning flex items-center justify-center sm:justify-start gap-2 font-bold">
                   <AlertTriangle className="w-4 h-4" />
                   {roleBlockers[0]}
                 </div>
               ) : (
                 <div className="text-sm text-muted-foreground font-bold flex items-center justify-center sm:justify-start gap-2">
                   <Check className="w-4 h-4 text-emerald-500" />
                   Configuration complete. Ready to estimate.
                 </div>
               )}
             </div>
             
             <button 
               onClick={runValidation} 
               disabled={roleBlockers.length > 0 || busy}
               className="w-full sm:w-auto bg-foreground text-background px-8 py-3.5 rounded-xl font-bold text-base hover:bg-foreground/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md"
             >
               {validateDraft.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Review & Estimate'}
               {!validateDraft.isPending && <ChevronRight className="w-5 h-5" />}
             </button>
          </div>
        )}
      </div>

      {/* Modals */}
      {showAgentLibrary && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="vls-reading-surface w-full max-w-3xl rounded-3xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in zoom-in-95 duration-200 border border-border">
            <div className="p-6 sm:p-8 border-b border-border flex items-start justify-between bg-background/50">
              <div>
                <h3 className="text-2xl font-display font-bold">Agent Library</h3>
                <p className="text-sm text-muted-foreground mt-1.5 font-medium">Select researchers to add to your session.</p>
              </div>
              <button onClick={() => setShowAgentLibrary(false)} className="text-muted-foreground hover:text-foreground p-2 rounded-xl hover:bg-muted/50 transition-colors"><X className="w-6 h-6"/></button>
            </div>
            
            <div className="p-6 sm:p-8 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 bg-background/20">
              {agents.length === 0 ? (
                <div className="col-span-full py-16 text-center text-base font-medium text-muted-foreground border-dashed border-2 rounded-2xl vls-glass">
                   No agents available. Create them in the Agents tab first.
                </div>
              ) : (
                agents.map(a => {
                   const isSelected = participants.some(p => p.agent.id === a.id);
                   const noVersion = !a.latest_version;
                   return (
                     <div 
                       key={a.id} 
                       onClick={() => {
                         if (!isSelected && !noVersion) {
                           addParticipant(a);
                         }
                       }}
                       className={`p-5 rounded-2xl border flex gap-4 text-left transition-all ${isSelected || noVersion ? 'opacity-50 cursor-not-allowed bg-muted/10 border-border/50' : 'cursor-pointer hover:border-primary/50 vls-glass hover:shadow-lg hover:-translate-y-0.5'}`}
                     >
                       <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-primary font-display font-bold text-lg border border-primary/20">
                         {a.title.charAt(0)}
                       </div>
                       <div className="flex-1 min-w-0 pt-0.5">
                         <div className="flex items-start justify-between mb-1.5 gap-2">
                           <div className="font-bold text-foreground truncate">{a.title}</div>
                           {!isSelected && !noVersion && <Plus className="w-5 h-5 text-primary flex-shrink-0" />}
                           {isSelected && <Check className="w-5 h-5 text-muted-foreground flex-shrink-0" />}
                         </div>
                         <div className="text-xs text-muted-foreground line-clamp-2 font-medium leading-relaxed">
                           {a.latest_version?.expertise ?? (noVersion ? 'No published version' : a.description)}
                         </div>
                       </div>
                     </div>
                   )
                })
              )}
            </div>
            <div className="p-6 border-t border-border flex justify-end bg-background/50">
              <button onClick={() => setShowAgentLibrary(false)} className="bg-foreground text-background px-8 py-3.5 rounded-xl text-sm font-bold hover:bg-foreground/90 transition-colors shadow-md">
                Done Adding
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
