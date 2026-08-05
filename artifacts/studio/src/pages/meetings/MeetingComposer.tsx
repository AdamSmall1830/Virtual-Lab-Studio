import React, { useState, useEffect } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useListProjects, useListTemplates, useListAgents, useLaunchRun } from '@workspace/api-client-react';
import { PageHeader } from '@/components/ui/page-header';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ChevronRight, ArrowLeft, Play, Info, AlertCircle } from 'lucide-react';

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export default function MeetingComposer() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const projectIdParam = searchParams.get('projectId');
  const templateIdParam = searchParams.get('templateId');
  
  const { toast } = useToast();
  const launchRun = useLaunchRun();

  const { data: projects } = useListProjects();
  const { data: templates } = useListTemplates();
  const { data: agents } = useListAgents();

  const [step, setStep] = useState<WizardStep>(1);

  // Form State
  const [projectId, setProjectId] = useState(projectIdParam || '');
  const [templateId, setTemplateId] = useState(templateIdParam || '');
  const [kind, setKind] = useState<'team' | 'individual'>('team');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [rounds, setRounds] = useState(2);
  const [questionsText, setQuestionsText] = useState('');
  const [rulesText, setRulesText] = useState('');
  const [leadId, setLeadId] = useState('');
  const [specialists, setSpecialists] = useState<string[]>([]);
  
  // Apply template if passed
  useEffect(() => {
    if (templateId && templateId !== 'none' && templates) {
      const t = templates.find(x => x.id === templateId);
      if (t) {
        setKind(t.kind as 'team' | 'individual');
        if (!title) setTitle(`Meeting: ${t.name}`);
        if (!objective) setObjective(t.objective || '');
        if (!questionsText && t.requiredQuestions?.length) setQuestionsText(t.requiredQuestions.join('\n'));
        if (!rulesText && t.rules?.length) setRulesText(t.rules.join('\n'));
        setRounds(t.defaultRounds || 2);
      }
    }
  }, [templateId, templates, title, objective, questionsText, rulesText]);

  const requiredQuestions = questionsText.split('\n').map(s => s.trim()).filter(Boolean);
  const rules = rulesText.split('\n').map(s => s.trim()).filter(Boolean);

  const handleLaunch = () => {
    if (!projectId || !title || !leadId) {
      toast({ title: 'Missing required fields', variant: 'destructive' });
      return;
    }
    
    const participants = [];
    const leadAgent = agents?.find(a => a.id === leadId);
    if (leadAgent) {
      participants.push({
        agentId: leadId,
        roleType: kind === 'team' ? 'lead' : 'expert',
        title: leadAgent.title,
      });
    }
    
    specialists.forEach(sId => {
      const s = agents?.find(a => a.id === sId);
      if (s) {
        participants.push({
          agentId: sId,
          roleType: kind === 'team' ? 'member' : 'critic',
          title: s.title,
        });
      }
    });

    launchRun.mutate({
      data: {
        projectId,
        templateId: templateId !== 'none' ? templateId : undefined,
        title,
        kind,
        agendaObjective: objective,
        requiredQuestions,
        rules,
        rounds,
        participants
      } as any
    }, {
      onSuccess: (run) => {
        toast({ title: 'Meeting launched', description: 'Redirecting to live room...' });
        setLocation(`/app/runs/${run.id}/live`);
      },
      onError: () => {
        toast({ title: 'Failed to launch meeting', variant: 'destructive' });
      }
    });
  };

  const currentCalls = kind === 'team' ? (rounds * (specialists.length + 1) + 1) : (2 * rounds + 1);

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto w-full flex flex-col min-h-full pb-20">
      <PageHeader 
        title="Compose Meeting" 
        description="Configure the agenda, select your AI agents, and launch a live deliberation."
      />

      <div className="flex gap-2 mb-8 sticky top-0 bg-background/80 backdrop-blur py-2 z-10">
        {[1,2,3,4,5,6].map(s => (
          <div key={s} className={`h-2 flex-1 rounded-full ${step >= s ? 'bg-primary' : 'bg-muted'}`} />
        ))}
      </div>

      <GlassPanel className="flex-1 flex flex-col p-6 md:p-8">
        {step === 1 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-display font-bold">1. Project & Mode</h2>
            
            <div className="space-y-4">
              <Label>Select Project *</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="vls-glass"><SelectValue placeholder="Choose project..." /></SelectTrigger>
                <SelectContent>
                  {projects?.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-4">
              <Label>Meeting Mode</Label>
              <div className="grid md:grid-cols-2 gap-4">
                <div 
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-colors ${kind === 'team' ? 'border-primary bg-primary/5' : 'border-border vls-glass hover:bg-muted/50'}`}
                  onClick={() => setKind('team')}
                >
                  <h3 className="font-bold mb-1">Team Meeting</h3>
                  <p className="text-sm text-muted-foreground">A lead coordinates a group of specialists.</p>
                </div>
                <div 
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-colors ${kind === 'individual' ? 'border-primary bg-primary/5' : 'border-border vls-glass hover:bg-muted/50'}`}
                  onClick={() => setKind('individual')}
                >
                  <h3 className="font-bold mb-1">Expert–Critic</h3>
                  <p className="text-sm text-muted-foreground">A paired debate between two agents.</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <Label>Template (Optional)</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger className="vls-glass"><SelectValue placeholder="No template" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No template</SelectItem>
                  {templates?.filter(t => t.kind === kind).map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Selecting a template pre-fills the agenda, required questions, rules, and rounds in the next steps. You can edit everything before launch.</p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-display font-bold">2. Agenda</h2>
            <div className="space-y-4">
              <Label>Meeting Title *</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Review of synthesis pathways" className="vls-glass" />
            </div>
            <div className="space-y-4">
              <Label>Objective</Label>
              <Textarea value={objective} onChange={e => setObjective(e.target.value)} placeholder="What is the goal of this meeting?" className="vls-glass min-h-[120px]" />
            </div>
            <div className="space-y-2">
              <Label>Required Questions</Label>
              <p className="text-xs text-muted-foreground">One per line. The team must answer each of these explicitly by the end of the meeting; answers appear in the structured synthesis.</p>
              <Textarea value={questionsText} onChange={e => setQuestionsText(e.target.value)} placeholder={'Which single variable should the pilot isolate?\nWhat acceptance criterion defines success?'} className="vls-glass min-h-[100px] font-mono text-sm" />
              {requiredQuestions.length > 0 && <p className="text-xs text-muted-foreground">{requiredQuestions.length} question{requiredQuestions.length === 1 ? '' : 's'} will be enforced.</p>}
            </div>
            <div className="space-y-2">
              <Label>Meeting Rules</Label>
              <p className="text-xs text-muted-foreground">One per line. Constraints the discussion must respect (optional).</p>
              <Textarea value={rulesText} onChange={e => setRulesText(e.target.value)} placeholder={'Only food-contact-safe additives may be considered.'} className="vls-glass min-h-[80px] font-mono text-sm" />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-display font-bold">3. Assemble Team</h2>
            
            <div className="space-y-4">
              <Label>{kind === 'team' ? 'Lead Agent *' : 'Expert Agent *'}</Label>
              <Select value={leadId} onValueChange={setLeadId}>
                <SelectTrigger className="vls-glass"><SelectValue placeholder="Select agent..." /></SelectTrigger>
                <SelectContent>
                  {agents?.filter(a => !a.archived).map(a => <SelectItem key={a.id} value={a.id}>{a.title} ({a.model})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-4">
              <Label>{kind === 'team' ? 'Specialists' : 'Critic Agent *'}</Label>
              <div className="space-y-3">
                {specialists.map((sId, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <Select value={sId} onValueChange={(val) => {
                      const newSpec = [...specialists];
                      newSpec[index] = val;
                      setSpecialists(newSpec);
                    }}>
                      <SelectTrigger className="vls-glass flex-1"><SelectValue placeholder="Select agent..." /></SelectTrigger>
                      <SelectContent>
                        {agents?.filter(a => !a.archived).map(a => <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="icon" onClick={() => {
                      setSpecialists(specialists.filter((_, i) => i !== index));
                    }}>-</Button>
                  </div>
                ))}
                
                {(!specialists.length || kind === 'team') && (
                  <Button variant="outline" onClick={() => setSpecialists([...specialists, ''])} className="w-full border-dashed">
                    + Add {kind === 'team' ? 'Specialist' : 'Critic'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-6 flex flex-col items-center justify-center text-center py-12">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-4">
              <Info className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-display font-bold">4. Evidence & Context</h2>
            <p className="text-muted-foreground max-w-md">
              Evidence grounding and document upload will be available in a future update. For now, include any necessary context directly in the Objective field.
            </p>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-display font-bold">5. Models & Controls</h2>
            
            <div className="space-y-4 max-w-md">
              <Label>Number of Rounds: {rounds}</Label>
              <input 
                type="range" 
                min="1" max="5" 
                value={rounds} 
                onChange={e => setRounds(parseInt(e.target.value))}
                className="w-full accent-primary"
              />
              <p className="text-sm text-muted-foreground mt-2">
                A round consists of {kind === 'team' ? 'the lead and all specialists speaking once.' : 'both the expert and critic speaking once.'}
              </p>
            </div>

            <GlassPanel className="p-6 mt-8 bg-surface-strong border-primary/20">
              <h3 className="font-semibold mb-2">Estimated Complexity</h3>
              <div className="flex justify-between items-center text-lg">
                <span>Planned API Calls</span>
                <span className="font-mono font-bold text-primary">{currentCalls} calls</span>
              </div>
            </GlassPanel>
          </div>
        )}

        {step === 6 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-display font-bold">6. Review & Launch</h2>
            
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <div className="text-sm text-muted-foreground">Title</div>
                  <div className="font-medium text-lg">{title}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Project</div>
                  <div className="font-medium">{projects?.find(p => p.id === projectId)?.name || 'Unknown'}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Mode</div>
                  <div className="font-medium capitalize">{kind}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Objective</div>
                  <div className="text-sm bg-muted/30 p-3 rounded mt-1 max-h-32 overflow-y-auto">{objective || 'None provided'}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Required Questions</div>
                  {requiredQuestions.length > 0 ? (
                    <ul className="text-sm bg-muted/30 p-3 rounded mt-1 max-h-32 overflow-y-auto list-disc pl-7 space-y-1">
                      {requiredQuestions.map((q, i) => <li key={i}>{q}</li>)}
                    </ul>
                  ) : <div className="text-sm bg-muted/30 p-3 rounded mt-1">None — the synthesis will not enforce specific answers</div>}
                </div>
                {rules.length > 0 && (
                  <div>
                    <div className="text-sm text-muted-foreground">Rules</div>
                    <ul className="text-sm bg-muted/30 p-3 rounded mt-1 max-h-32 overflow-y-auto list-disc pl-7 space-y-1">
                      {rules.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="text-sm text-muted-foreground">Speaking Order</div>
                <div className="space-y-2">
                  {leadId && (
                    <div className="flex items-center gap-2 p-2 rounded bg-surface-strong border border-border text-sm">
                      <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs">1</span>
                      {agents?.find(a => a.id === leadId)?.title} (Lead)
                    </div>
                  )}
                  {specialists.filter(Boolean).map((s, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 rounded bg-surface-strong border border-border text-sm">
                      <span className="w-5 h-5 rounded-full bg-secondary/20 text-secondary flex items-center justify-center text-xs">{i+2}</span>
                      {agents?.find(a => a.id === s)?.title} ({kind === 'team' ? 'Specialist' : 'Critic'})
                    </div>
                  ))}
                </div>

                <div className="bg-warning/10 border border-warning/20 p-4 rounded-lg flex items-start gap-3 mt-4">
                  <AlertCircle className="w-5 h-5 text-warning shrink-0" />
                  <p className="text-sm text-warning-foreground leading-relaxed">
                    Models will consume tokens for each API call. The context window grows linearly with each speaker.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-auto pt-8 flex justify-between items-center border-t border-border/40">
          <Button variant="ghost" onClick={() => setStep(s => Math.max(1, s - 1) as WizardStep)} disabled={step === 1}>
            <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          
          {step < 6 ? (
            <Button onClick={() => setStep(s => Math.min(6, s + 1) as WizardStep)}>
              Next <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button size="lg" onClick={handleLaunch} disabled={launchRun.isPending || !projectId || !title || !leadId}>
              {launchRun.isPending ? 'Launching...' : <><Play className="w-4 h-4 mr-2" /> Launch Meeting</>}
            </Button>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
