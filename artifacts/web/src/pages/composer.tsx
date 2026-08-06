import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  ChevronRight, ArrowLeft, Play, Settings, Users, Clock, AlertTriangle,
  ShieldCheck, Loader2, CheckCircle2, XCircle, Plus, X,
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

const STEPS = ['Mode & Template', 'Agenda', 'Team', 'Evidence', 'Controls', 'Review'];
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
  const [step, setStep] = useState(0);
  const [projectId, setProjectId] = useState<string>('');
  const [templateId, setTemplateId] = useState<string>('');
  const [title, setTitle] = useState('New Meeting');
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

  // Default project selection once projects load.
  useEffect(() => {
    if (projectId || projects.length === 0) return;
    const preferred =
      (initialProject && projects.find((p) => p.id === initialProject)?.id) || projects[0].id;
    setProjectId(preferred);
  }, [projectId, projects, initialProject]);
  const resolvedProjectId = projectId || initialProject || projects[0]?.id || '';

  // Provider defaults: prefer demo provider + its first enabled model.
  const defaultProvider = useMemo(() => {
    const demo = providers.find((p) => p.provider_type === 'demo' && p.is_enabled);
    return demo ?? providers.find((p) => p.is_enabled) ?? providers[0];
  }, [providers]);
  const defaultModel = useMemo(() => {
    const models = defaultProvider?.models ?? [];
    return models.find((m) => m.is_enabled) ?? models[0];
  }, [defaultProvider]);

  const evidenceQuery = useProjectEvidence(projectId, {
    query: { queryKey: getProjectEvidenceQueryKey(projectId), enabled: Boolean(projectId) && enabled },
  });
  const evidence: EvidenceSourceOut[] = evidenceQuery.data ?? [];

  const createDraft = useCreateDraft();
  const validateDraft = useValidateDraft();
  const launchDraft = useLaunchDraft();

  const [estimate, setEstimate] = useState<ValidationEstimateOut | null>(null);
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
    // applyTemplate reads latest state via closure; deps kept minimal intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedUrlTemplate, initialTemplate, templateId, templates, agents]);

  // ---- roster helpers ----
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

  // ---- client-side role validation ----
  const roleBlockers = useMemo(() => {
    const b: string[] = [];
    if (!resolvedProjectId) b.push('Select a project.');
    if (!title.trim()) b.push('Provide a meeting title.');
    if (!agenda.trim()) b.push('Provide an agenda.');
    if (!defaultProvider || !defaultModel) b.push('No enabled provider/model is available in this workspace.');
    const roles = participants.map((p) => p.roleType);
    if (meetingType === 'team') {
      if (roles.filter((r) => r === 'lead').length !== 1) b.push('A team meeting needs exactly one lead.');
      if (roles.filter((r) => r === 'member').length < 1) b.push('A team meeting needs at least one member.');
      if (roles.some((r) => r === 'expert' || r === 'critic')) {
        b.push('Team meetings only use lead and member roles.');
      }
    } else {
      if (roles.filter((r) => r === 'expert').length !== 1) b.push('An individual meeting needs exactly one expert.');
      if (roles.filter((r) => r === 'critic').length !== 1) b.push('An individual meeting needs exactly one critic.');
      if (roles.some((r) => r === 'lead' || r === 'member')) {
        b.push('Individual meetings only use expert and critic roles.');
      }
    }
    if (rounds < 1 || rounds > 12) b.push('Rounds must be between 1 and 12.');
    return b;
  }, [resolvedProjectId, title, agenda, defaultProvider, defaultModel, participants, meetingType, rounds]);

  const canLaunch = roleBlockers.length === 0;

  const buildDraft = (): MeetingDraftIn => {
    const budget: Record<string, number> = {};
    if (maxProviderCalls > 0) budget.max_provider_calls = maxProviderCalls;
    if (maxCostUsd > 0) budget.max_cost_usd = maxCostUsd;
    const agentsIn: DraftAgentIn[] = participants.map((p, idx) => ({
      position: idx,
      role_type: p.roleType,
      agent_version_id: p.agent.latest_version?.id ?? '',
      provider_config_id: defaultProvider!.id,
      provider_model_id: defaultModel!.id,
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

  // ---- create + validate (on entering Review step) ----
  const runValidation = async () => {
    setLaunchError(null);
    setEstimate(null);
    if (!canLaunch) return;
    try {
      const draft = await createDraft.mutateAsync({
        projectId: resolvedProjectId,
        data: buildDraft(),
      });
      const est = await validateDraft.mutateAsync({ draftId: draft.id });
      setEstimate(est);
      return draft.id;
    } catch (err) {
      setLaunchError(errMessage(err, 'Failed to prepare the draft.'));
      return undefined;
    }
  };

  const goToReview = async () => {
    setStep(5);
    await runValidation();
  };

  const handleLaunch = async () => {
    setLaunchError(null);
    if (!canLaunch) return;
    try {
      // Recreate + validate to capture the latest edits, then launch.
      const draft = await createDraft.mutateAsync({
        projectId: resolvedProjectId,
        data: buildDraft(),
      });
      const est = await validateDraft.mutateAsync({ draftId: draft.id });
      setEstimate(est);
      if (!est.valid) {
        setLaunchError('The draft failed server validation. Review the errors below.');
        return;
      }
      const launched = await launchDraft.mutateAsync({ draftId: draft.id });
      toast({ title: 'Meeting launched', description: 'The run is queued and starting.' });
      setLocation(`/app/runs/${launched.run_id}/live`);
    } catch (err) {
      setLaunchError(errMessage(err, 'Launch failed.'));
    }
  };

  // ---- loading / error gates ----
  const coreLoading =
    projectsQuery.isLoading || templatesQuery.isLoading || agentsQuery.isLoading || providersQuery.isLoading;
  const coreError =
    projectsQuery.isError || templatesQuery.isError || agentsQuery.isError || providersQuery.isError;

  if (coreLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm">Loading the composer…</p>
      </div>
    );
  }
  if (coreError) {
    return (
      <div className="max-w-md mx-auto mt-16 vls-glass rounded-xl p-8 text-center border border-destructive/30 bg-destructive/5">
        <AlertTriangle className="w-10 h-10 text-destructive mx-auto mb-4" />
        <h2 className="text-lg font-semibold mb-2">Could not load workspace data</h2>
        <p className="text-sm text-muted-foreground mb-4">
          We couldn&apos;t load projects, agents, or providers. Try again.
        </p>
        <button
          onClick={() => {
            projectsQuery.refetch();
            templatesQuery.refetch();
            agentsQuery.refetch();
            providersQuery.refetch();
          }}
          className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 hover:bg-foreground/90 transition-colors"
        >
          <Loader2 className="w-4 h-4" /> Retry
        </button>
      </div>
    );
  }
  if (projects.length === 0) {
    return (
      <div className="max-w-md mx-auto mt-16 vls-glass rounded-xl p-8 text-center border-dashed">
        <Users className="w-10 h-10 text-muted-foreground mx-auto mb-4 opacity-60" />
        <h2 className="text-lg font-semibold mb-2">No projects yet</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Create a project before composing a meeting.
        </p>
        <button
          onClick={() => setLocation('/app/projects')}
          className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold hover:bg-foreground/90 transition-colors"
        >
          Go to Projects
        </button>
      </div>
    );
  }

  const getStepForBlocker = (b: string) => {
    const l = b.toLowerCase();
    if (l.includes('project')) return 0;
    if (l.includes('title') || l.includes('agenda')) return 1;
    if (l.includes('lead') || l.includes('member') || l.includes('expert') || l.includes('critic')) return 2;
    if (l.includes('rounds')) return 4;
    return 0;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] animate-in fade-in duration-300 max-w-6xl mx-auto pb-4">
      {/* Wizard header */}
      <div className="shrink-0 mb-6 border-b border-border pb-6">
        <button
          onClick={() => setLocation('/app/runs')}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-display font-bold">Meeting Composer</h1>
          <div className="hidden md:flex items-center gap-2 text-sm">
            {STEPS.map((s, i) => (
              <React.Fragment key={i}>
                <div
                  className={`flex items-center gap-2 ${
                    i === step ? 'text-primary font-semibold' : i < step ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                      i === step
                        ? 'bg-primary text-primary-foreground'
                        : i < step
                          ? 'bg-foreground text-background'
                          : 'bg-background border border-border'
                    }`}
                  >
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
        {/* Step 0: Mode & Template */}
        {step === 0 && (
          <div className="max-w-2xl mx-auto space-y-8 py-8 animate-in slide-in-from-right-4">
            <div className="text-center">
              <h2 className="text-3xl font-display font-bold mb-2">Select a Meeting Mode</h2>
              <p className="text-muted-foreground">The mode defines the interaction pattern between agents.</p>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div
                className={`p-6 rounded-xl cursor-pointer border-2 transition-all ${
                  meetingType === 'team' ? 'border-primary bg-primary/5' : 'border-transparent vls-glass hover:border-border'
                }`}
                onClick={() => setMeetingType('team')}
              >
                <h3 className="text-xl font-semibold mb-2">Team Council</h3>
                <p className="text-sm text-muted-foreground">
                  Lead investigator + ordered specialists. Best for multidisciplinary synthesis and complex
                  experimental design.
                </p>
              </div>
              <div
                className={`p-6 rounded-xl cursor-pointer border-2 transition-all ${
                  meetingType === 'individual' ? 'border-primary bg-primary/5' : 'border-transparent vls-glass hover:border-border'
                }`}
                onClick={() => setMeetingType('individual')}
              >
                <h3 className="text-xl font-semibold mb-2">Expert &amp; Critic</h3>
                <p className="text-sm text-muted-foreground">
                  One expert alternates with a dedicated critic. Best for rigorous stress-testing of a specific
                  hypothesis.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Project Context</label>
              <select
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                value={resolvedProjectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setEvidenceIds([]);
                }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Start from a Template (optional)</label>
              <select
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                value={templateId}
                onChange={(e) => (e.target.value ? applyTemplate(e.target.value) : setTemplateId(''))}
              >
                <option value="">Blank meeting</option>
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
              {prefilledTemplate && (
                <p className="text-xs text-muted-foreground">
                  Prefilled agenda, questions, rules, and roster from the template.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 1: Agenda */}
        {step === 1 && (
          <div className="max-w-3xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
            <h2 className="text-2xl font-display font-bold">Agenda &amp; Objectives</h2>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Meeting Title</label>
                <input
                  type="text"
                  className="w-full bg-background border border-input rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Primary Objective / Agenda</label>
                <textarea
                  className="w-full bg-background border border-input rounded-md px-3 py-2 min-h-[100px] focus:outline-none focus:ring-2 focus:ring-primary"
                  value={agenda}
                  onChange={(e) => setAgenda(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Agenda Questions (one per line)</label>
                  <textarea
                    className="w-full bg-background border border-input rounded-md px-3 py-2 min-h-[150px] focus:outline-none focus:ring-2 focus:ring-primary text-sm"
                    value={questions}
                    onChange={(e) => setQuestions(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-warning">Constraints / Rules (one per line)</label>
                  <textarea
                    className="w-full bg-background border border-warning/50 rounded-md px-3 py-2 min-h-[150px] focus:outline-none focus:ring-2 focus:ring-warning/50 text-sm"
                    value={rules}
                    onChange={(e) => setRules(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Team */}
        {step === 2 && (
          <div className="max-w-4xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-display font-bold">Team Assembly</h2>
              <span className="text-sm text-muted-foreground">{participants.length} agents selected</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2 space-y-4">
                <div className="vls-glass p-4 rounded-xl border-l-4 border-l-primary">
                  <div className="text-sm font-semibold mb-3 uppercase tracking-wider text-muted-foreground">
                    Meeting Roster (Speaking Order)
                  </div>
                  <div className="space-y-2">
                    {participants.map((p, idx) => (
                      <div
                        key={p.agent.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between bg-background p-3 rounded-lg border border-border gap-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-6 h-6 rounded bg-primary/10 text-primary text-xs flex items-center justify-center font-mono">
                            {idx + 1}
                          </div>
                          <div className="font-medium text-sm">{p.agent.title}</div>
                        </div>
                        <div className="flex items-center gap-3 sm:ml-auto">
                          <select
                            value={p.roleType}
                            onChange={(e) => setRole(p.agent.id, e.target.value as DraftAgentInRoleType)}
                            className="text-xs bg-background border border-border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/50"
                          >
                            {meetingType === 'team' ? (
                              <>
                                <option value="lead">Lead</option>
                                <option value="member">Member</option>
                              </>
                            ) : (
                              <>
                                <option value="expert">Expert</option>
                                <option value="critic">Critic</option>
                              </>
                            )}
                          </select>
                          <button
                            className="text-destructive hover:bg-destructive/10 rounded p-1"
                            onClick={() => removeParticipant(p.agent.id)}
                            title="Remove"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {participants.length === 0 && (
                      <div className="text-center py-6 text-muted-foreground text-sm border border-dashed rounded-lg">
                        Add agents from the library to build your team.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="vls-reading-surface rounded-xl p-4 border h-[500px] overflow-auto">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Users className="w-4 h-4" /> Agent Library
                </h3>
                {agents.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-8">
                    No agents available in this workspace.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {agents.map((a) => {
                      const isSelected = participants.some((p) => p.agent.id === a.id);
                      const noVersion = !a.latest_version;
                      return (
                        <div
                          key={a.id}
                          className={`p-3 rounded-lg border text-sm transition-colors ${
                            isSelected || noVersion
                              ? 'border-primary/50 bg-primary/5 opacity-50 cursor-not-allowed'
                              : 'border-border bg-background cursor-pointer hover:border-primary/50'
                          }`}
                          onClick={() => !isSelected && !noVersion && addParticipant(a)}
                        >
                          <div className="font-medium mb-1 flex items-center justify-between">
                            {a.title}
                            {!isSelected && !noVersion && <Plus className="w-3.5 h-3.5 text-primary" />}
                          </div>
                          <div className="text-xs text-muted-foreground line-clamp-2">
                            {a.latest_version?.expertise ?? (noVersion ? 'No version available' : a.description)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Evidence */}
        {step === 3 && (
          <div className="max-w-4xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-display font-bold">Evidence Context</h2>
              <span className="text-sm font-medium bg-primary/10 text-primary px-3 py-1 rounded-full">
                {evidenceIds.length} sources attached
              </span>
            </div>

            {evidenceQuery.isLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-20 rounded-xl bg-muted/40 animate-pulse" />
                ))}
              </div>
            ) : evidenceQuery.isError ? (
              <div className="p-6 rounded-xl border border-destructive/30 bg-destructive/5 text-sm text-destructive text-center">
                Failed to load evidence for this project.
              </div>
            ) : evidence.length === 0 ? (
              <div className="text-center py-12 vls-glass border-dashed rounded-xl text-muted-foreground">
                No evidence available. Upload documents in the Evidence Library.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {evidence.map((ev) => {
                  const selected = evidenceIds.includes(ev.id);
                  const notReady = ev.processing_status !== 'ready';
                  return (
                    <label
                      key={ev.id}
                      className={`flex items-start gap-4 p-4 rounded-xl border-2 transition-all ${
                        selected ? 'border-primary bg-primary/5' : 'border-border vls-glass hover:border-primary/30'
                      } ${notReady ? 'opacity-60' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 w-4 h-4 rounded border-border text-primary focus:ring-primary"
                        checked={selected}
                        disabled={notReady}
                        onChange={(e) => {
                          setEvidenceIds((prev) =>
                            e.target.checked ? [...prev, ev.id] : prev.filter((id) => id !== ev.id),
                          );
                        }}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-foreground mb-1 flex items-center gap-2">
                          {ev.title}
                          <span className="text-[10px] font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                            {ev.evidence_key}
                          </span>
                          {notReady && (
                            <span className="text-[10px] text-warning uppercase tracking-wider">
                              {ev.processing_status}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground line-clamp-2">
                          {ev.citation ?? ev.source_type}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Step 4: Controls */}
        {step === 4 && (
          <div className="max-w-2xl mx-auto space-y-8 py-4 animate-in slide-in-from-right-4">
            <h2 className="text-2xl font-display font-bold mb-6">Execution Controls</h2>
            <div className="space-y-6">
              <div className="vls-reading-surface p-6 rounded-xl border space-y-4">
                <h3 className="font-semibold border-b border-border pb-2">Debate Parameters</h3>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Rounds (1–12)</label>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={rounds}
                      onChange={(e) => setRounds(Math.min(12, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                    />
                    <div className="text-xs text-muted-foreground">Full cycles through the speaking roster</div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Temperature (0–2)</label>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      max={2}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={temperature}
                      onChange={(e) =>
                        setTemperature(Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="vls-reading-surface p-6 rounded-xl border space-y-4 border-warning/30">
                <div className="border-b border-border pb-2">
                  <h3 className="font-semibold text-warning flex items-center gap-2">
                    <Settings className="w-4 h-4" /> Budgets &amp; Limits
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Limits are enforced at safe checkpoints. Set a limit to 0 for unlimited.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Max Provider Calls</label>
                    <input
                      type="number"
                      min={0}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={maxProviderCalls}
                      onChange={(e) => setMaxProviderCalls(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Max Cost (USD)</label>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      className="w-full bg-background border border-input rounded-md px-3 py-2"
                      value={maxCostUsd}
                      onChange={(e) => setMaxCostUsd(Math.max(0, parseFloat(e.target.value) || 0))}
                    />
                    <p className="text-xs text-muted-foreground">Demo Provider runs cost $0.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 5: Review */}
        {step === 5 && (
          <div className="max-w-3xl mx-auto space-y-6 py-4 animate-in slide-in-from-right-4">
            <div className="text-center mb-6">
              <h2 className="text-3xl font-display font-bold">Review &amp; Launch</h2>
              <p className="text-muted-foreground mt-2">
                Verify parameters before launching the meeting run.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="vls-glass p-5 rounded-xl space-y-4">
                <h3 className="font-semibold flex items-center gap-2 border-b border-border pb-2">
                  <Users className="w-4 h-4 text-primary" /> Setup
                </h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Mode</span>
                    <span className="font-medium capitalize">{meetingType}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Team Size</span>
                    <span className="font-medium">{participants.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Evidence</span>
                    <span className="font-medium">{evidenceIds.length} sources</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Rounds</span>
                    <span className="font-medium">{rounds}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Provider</span>
                    <span className="font-medium">
                      {defaultProvider?.name ?? '—'} ({defaultModel?.model_key ?? '—'})
                    </span>
                  </div>
                </div>
              </div>

              <div className="vls-glass p-5 rounded-xl space-y-4">
                <h3 className="font-semibold flex items-center gap-2 border-b border-border pb-2">
                  <Clock className="w-4 h-4 text-secondary" /> Estimates
                </h3>
                {validateDraft.isPending || createDraft.isPending ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                    <Loader2 className="w-4 h-4 animate-spin" /> Validating…
                  </div>
                ) : estimate ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Provider Calls</span>
                      <span className="font-mono">~{estimate.base_calls ?? '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Input Tokens</span>
                      <span className="font-mono">
                        ~{(estimate.estimated_input_tokens ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Output Tokens</span>
                      <span className="font-mono">
                        ~{(estimate.estimated_output_tokens ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cost</span>
                      <span className="font-mono">
                        ${(estimate.estimated_cost_usd ?? 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground py-4">
                    Estimates will appear once validated.
                  </div>
                )}
              </div>
            </div>

            {/* Server validation results */}
            {estimate && estimate.errors.length > 0 && (
              <div className="vls-glass p-5 rounded-xl border border-destructive/30 bg-destructive/5 space-y-2">
                <h3 className="font-semibold text-destructive flex items-center gap-2">
                  <XCircle className="w-4 h-4" /> Validation Errors
                </h3>
                <ul className="list-disc pl-5 text-sm text-destructive/90 space-y-1">
                  {estimate.errors.map((e, i) => (
                    <li key={i}>{Object.values(e).join(' — ')}</li>
                  ))}
                </ul>
              </div>
            )}
            {estimate && estimate.warnings.length > 0 && (
              <div className="vls-glass p-5 rounded-xl border border-warning/30 bg-warning/5 space-y-2">
                <h3 className="font-semibold text-warning flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> Warnings
                </h3>
                <ul className="list-disc pl-5 text-sm text-warning/90 space-y-1">
                  {estimate.warnings.map((w, i) => (
                    <li key={i}>{Object.values(w).join(' — ')}</li>
                  ))}
                </ul>
              </div>
            )}
            {estimate && estimate.valid && estimate.errors.length === 0 && (
              <div className="bg-accent/5 border border-accent/20 p-4 rounded-xl flex gap-3 items-center">
                <CheckCircle2 className="w-5 h-5 text-accent shrink-0" />
                <p className="text-sm text-foreground">
                  Draft validated. Ready to launch.
                </p>
              </div>
            )}

            <div className="bg-primary/5 border border-primary/20 p-5 rounded-xl flex gap-4">
              <ShieldCheck className="w-6 h-6 text-primary shrink-0" />
              <div>
                <h4 className="font-semibold text-sm mb-1 text-primary">Oversight Notice</h4>
                <p className="text-xs text-muted-foreground">
                  AI participants are model personas, not human experts. Outputs are decision support, not
                  validated conclusions, and require human review.
                </p>
              </div>
            </div>

            {roleBlockers.length > 0 && (
              <div className="vls-glass p-5 rounded-xl border border-warning/30 bg-warning/5 space-y-3">
                <h3 className="font-semibold text-warning flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> Cannot Launch Yet
                </h3>
                <ul className="list-disc pl-5 text-sm text-warning/80 space-y-1.5">
                  {roleBlockers.map((b, i) => (
                    <li key={i}>
                      <button onClick={() => setStep(getStepForBlocker(b))} className="hover:underline text-left">
                        {b}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {launchError && (
              <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-destructive text-sm font-medium">
                {launchError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer navigation */}
      <div className="shrink-0 mt-6 pt-4 border-t border-border flex justify-between items-center bg-background z-10 relative">
        <button
          className="px-6 py-2.5 rounded-lg font-medium text-sm border border-border hover:bg-background/50 transition-colors disabled:opacity-50"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0 || busy}
        >
          Previous
        </button>
        {step < STEPS.length - 1 ? (
          <button
            className="px-6 py-2.5 bg-foreground text-background rounded-lg font-medium text-sm hover:bg-foreground/90 transition-colors disabled:opacity-50"
            onClick={() => (step === 4 ? goToReview() : setStep((s) => Math.min(STEPS.length - 1, s + 1)))}
            disabled={busy}
          >
            {step === 4 ? 'Review' : 'Continue'}
          </button>
        ) : (
          <button
            className="px-8 py-2.5 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50"
            onClick={handleLaunch}
            disabled={!canLaunch || busy}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
            Launch Meeting
          </button>
        )}
      </div>
    </div>
  );
}
