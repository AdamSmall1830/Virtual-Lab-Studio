import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useProjectPreRegistrations,
  getProjectPreRegistrationsQueryKey,
  usePreRegistration,
  useCreatePreRegistration,
  useUpdatePreRegistration,
  useRegisterPreRegistration,
  useWithdrawPreRegistration,
  useSetPreRegistrationPolicy,
  getGetProjectApiV1ProjectsProjectIdGetQueryKey,
  type ProjectOut,
  type PreRegistrationListItem,
  type PreRegistrationOut
} from '@/api';
import { Loader2, Plus, AlertTriangle, ShieldCheck, Check, History, Lock, FileText, ChevronRight, X, ShieldAlert } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from '@/hooks/use-toast';
import { apiErrorMessage } from '@/lib/api-error';

export default function PreRegistrationTab({ projectId, project }: { projectId: string; project: ProjectOut }) {
  const queryClient = useQueryClient();
  const policyMut = useSetPreRegistrationPolicy();
  
  const { data: list, isLoading, isError } = useProjectPreRegistrations(projectId, {
    query: { enabled: !!projectId, queryKey: getProjectPreRegistrationsQueryKey(projectId) }
  });

  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policyWarning, setPolicyWarning] = useState<string | null>(null);

  const togglePolicy = async () => {
    setPolicyError(null);
    setPolicyWarning(null);
    try {
      const res = await policyMut.mutateAsync({
        projectId,
        data: { pre_registration_required: !project.pre_registration_required }
      });
      queryClient.invalidateQueries({ queryKey: getGetProjectApiV1ProjectsProjectIdGetQueryKey(projectId) });
      if (res.warning) {
        setPolicyWarning(res.warning);
      }
    } catch (err: any) {
      if (err?.status === 403) {
        setPolicyError("Only workspace owners or admins can change the pre-registration policy.");
      } else {
        setPolicyError(apiErrorMessage(err, "Failed to update policy."));
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-12 text-center text-destructive">
        <AlertTriangle className="w-8 h-8 mx-auto mb-4" />
        <p>Failed to load pre-registrations.</p>
      </div>
    );
  }

  const items = list || [];
  const activeRegistered = items.find(i => i.status === 'registered');
  const drafts = items.filter(i => i.status === 'draft');
  const superseded = items.filter(i => i.status === 'superseded').sort((a, b) => b.version - a.version);
  const withdrawn = items.filter(i => i.status === 'withdrawn');

  return (
    <div className="space-y-6">
      {/* Policy Card */}
      <div className="vls-reading-surface rounded-xl p-6 border border-border">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-lg font-display font-semibold flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" />
              Pre-registration Requirement
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Require a registered protocol before any runs can be launched in this project.
            </p>
          </div>
          <button
            onClick={togglePolicy}
            disabled={policyMut.isPending}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${
              project.pre_registration_required ? 'bg-primary' : 'bg-input'
            } disabled:opacity-50`}
          >
            <span className="sr-only">Toggle requirement</span>
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out ${
                project.pre_registration_required ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        {policyError && (
          <div className="mt-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
            <Lock className="w-4 h-4" />
            {policyError}
          </div>
        )}
        {policyWarning && (
          <div className="mt-4 p-3 rounded-lg bg-warning/10 text-warning-foreground border border-warning/30 text-sm font-medium flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-warning" />
            {policyWarning}
          </div>
        )}
      </div>

      <DraftList projectId={projectId} drafts={drafts} activeRegisteredId={activeRegistered?.id} />

      {activeRegistered && (
        <RegisteredView item={activeRegistered} />
      )}

      {superseded.length > 0 && (
        <div className="vls-reading-surface rounded-xl p-6 border border-border">
          <h3 className="text-sm font-display font-semibold flex items-center gap-2 mb-4 text-muted-foreground">
            <History className="w-4 h-4" />
            Version History
          </h3>
          <div className="space-y-3">
            {superseded.map(s => (
              <HistoryItem key={s.id} item={s} />
            ))}
          </div>
        </div>
      )}

      {withdrawn.length > 0 && (
        <div className="vls-reading-surface rounded-xl p-6 border border-border opacity-70">
          <h3 className="text-sm font-display font-semibold flex items-center gap-2 mb-4 text-muted-foreground">
            <X className="w-4 h-4" />
            Withdrawn
          </h3>
          <div className="space-y-3">
            {withdrawn.map(w => (
              <HistoryItem key={w.id} item={w} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DraftList({ projectId, drafts, activeRegisteredId }: { projectId: string; drafts: PreRegistrationListItem[]; activeRegisteredId?: string }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const createMut = useCreatePreRegistration();
  const queryClient = useQueryClient();

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const res = await createMut.mutateAsync({
        projectId,
        data: {
          title: "New Pre-registration",
          supersedes_id: activeRegisteredId || null
        }
      });
      queryClient.invalidateQueries({ queryKey: getProjectPreRegistrationsQueryKey(projectId) });
      setEditingId(res.id);
    } catch (err: any) {
      toast({
        title: "Failed to create draft",
        description: apiErrorMessage(err, "The document could not be saved."),
        variant: "destructive"
      });
    } finally {
      setIsCreating(false);
    }
  };

  if (editingId) {
    return <DraftEditor preregId={editingId} onBack={() => setEditingId(null)} />;
  }

  return (
    <div className="space-y-4">
      {drafts.length > 0 ? (
        <div className="space-y-3">
          {drafts.map(draft => (
            <div key={draft.id} className="vls-reading-surface rounded-xl p-5 border border-primary/30 flex items-center justify-between group">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-primary/10 text-primary">DRAFT</span>
                  <span className="text-sm text-muted-foreground">Version {draft.version}</span>
                </div>
                <h3 className="font-bold text-lg">{draft.title}</h3>
                <p className="text-xs text-muted-foreground mt-1">Last updated {format(new Date(draft.updated_at), 'MMM d, yyyy')}</p>
              </div>
              <button
                onClick={() => setEditingId(draft.id)}
                className="bg-secondary text-secondary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-secondary/90 transition-colors flex items-center gap-2"
              >
                Resume Editing <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="vls-glass rounded-xl p-8 text-center border-dashed border-2">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <FileText className="w-6 h-6 text-primary" />
          </div>
          <h3 className="text-lg font-bold mb-2">No active draft</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
            {activeRegisteredId ? "Create a new amendment to supersede the current registered protocol." : "Start a pre-registration to freeze your hypotheses and analysis plan."}
          </p>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className="bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:bg-primary/90 flex items-center gap-2 mx-auto disabled:opacity-50"
          >
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {activeRegisteredId ? "New Amendment" : "New Pre-registration"}
          </button>
        </div>
      )}
    </div>
  );
}

function RegisteredView({ item }: { item: PreRegistrationListItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border-2 border-primary/50 overflow-hidden bg-background">
      <div className="bg-primary/5 p-6 border-b border-primary/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-bold px-2 py-0.5 rounded bg-primary text-primary-foreground flex items-center gap-1">
              <Lock className="w-3 h-3" /> REGISTERED
            </span>
            <span className="text-sm font-medium text-primary">Version {item.version}</span>
          </div>
          <h3 className="text-xl font-display font-bold text-foreground">{item.title}</h3>
          <div className="text-xs text-muted-foreground mt-2 font-mono bg-background/50 px-2 py-1 rounded inline-block border border-border/50">
            Hash: {item.content_hash || 'pending'}
          </div>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-sm font-medium text-primary hover:underline px-3 py-1.5"
        >
          {expanded ? "Hide Details" : "View Details"}
        </button>
      </div>
      
      {expanded && (
        <div className="p-0 border-t border-border">
          <DocumentDetails preregId={item.id} />
        </div>
      )}
    </div>
  );
}

function HistoryItem({ item }: { item: PreRegistrationListItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-background">
      <div 
        className="p-4 flex items-center justify-between cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
            v{item.version}
          </div>
          <div>
            <h4 className="font-bold text-sm text-foreground">{item.title}</h4>
            <div className="text-xs text-muted-foreground mt-0.5 flex gap-2">
              <span className="uppercase">{item.status}</span>
              <span>•</span>
              <span className="font-mono">{item.content_hash?.substring(0, 12)}...</span>
            </div>
          </div>
        </div>
        <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </div>
      {expanded && (
        <div className="border-t border-border p-4 bg-muted/10">
          <DocumentDetails preregId={item.id} />
        </div>
      )}
    </div>
  );
}

function DocumentDetails({ preregId }: { preregId: string }) {
  const { data, isLoading, isError } = usePreRegistration(preregId, {
    query: { enabled: !!preregId, queryKey: ['prereg', preregId] }
  });

  if (isLoading) return <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  if (isError || !data) return <div className="p-8 text-center text-sm text-destructive">Failed to load document details.</div>;

  return (
    <div className="p-6 space-y-6 text-sm">
      {data.amendment_reason && (
        <div className="bg-secondary/10 border border-secondary/30 rounded-lg p-4">
          <h4 className="font-bold text-secondary mb-1">Amendment Reason</h4>
          <p className="text-foreground">{data.amendment_reason}</p>
        </div>
      )}
      
      {data.withdrawn_reason && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4">
          <h4 className="font-bold text-destructive mb-1">Withdrawal Reason</h4>
          <p className="text-foreground">{data.withdrawn_reason}</p>
        </div>
      )}

      {data.launch_impact && (
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
          <h4 className="font-bold text-primary mb-1">Launch Impact</h4>
          <p className="text-foreground">{data.launch_impact}</p>
        </div>
      )}

      <div className="grid gap-6">
        {data.content_hash && (
          <div>
            <h4 className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-xs">Content Hash Fingerprint</h4>
            <div className="font-mono text-xs text-foreground bg-background rounded-md p-3 border break-all">
              {data.content_hash}
            </div>
          </div>
        )}
        <div>
          <h4 className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-xs">Hypothesis</h4>
          <div className="whitespace-pre-wrap text-foreground bg-background rounded-md p-3 border">{data.hypothesis || 'None'}</div>
        </div>
        <div>
          <h4 className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-xs">Protocol</h4>
          <div className="whitespace-pre-wrap text-foreground bg-background rounded-md p-3 border">{data.protocol || 'None'}</div>
        </div>
        <div>
          <h4 className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-xs">Expected Outcomes</h4>
          <div className="whitespace-pre-wrap text-foreground bg-background rounded-md p-3 border">{data.expected_outcomes || 'None'}</div>
        </div>
        <div>
          <h4 className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-xs">Success Criteria</h4>
          <div className="whitespace-pre-wrap text-foreground bg-background rounded-md p-3 border">{data.success_criteria || 'None'}</div>
        </div>
        <div>
          <h4 className="font-bold text-muted-foreground mb-2 uppercase tracking-wider text-xs">Analysis Plan</h4>
          <div className="whitespace-pre-wrap text-foreground bg-background rounded-md p-3 border">{data.analysis_plan || 'None'}</div>
        </div>
      </div>
      
      <div className="text-xs text-muted-foreground pt-4 border-t flex flex-col gap-1">
        {data.registered_at && <div>Registered: {format(new Date(data.registered_at), 'PPpp')} by {data.registered_by}</div>}
        {data.withdrawn_at && <div>Withdrawn: {format(new Date(data.withdrawn_at), 'PPpp')}</div>}
      </div>
    </div>
  );
}

function DraftEditor({ preregId, onBack }: { preregId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = usePreRegistration(preregId, {
    query: { enabled: !!preregId, queryKey: ['prereg', preregId] }
  });
  const updateMut = useUpdatePreRegistration();
  const registerMut = useRegisterPreRegistration();
  const withdrawMut = useWithdrawPreRegistration();

  const [form, setForm] = useState({
    title: '',
    hypothesis: '',
    protocol: '',
    expected_outcomes: '',
    success_criteria: '',
    analysis_plan: '',
    amendment_reason: ''
  });

  const [saving, setSaving] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [confirmRegister, setConfirmRegister] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');

  useEffect(() => {
    if (data) {
      setForm({
        title: data.title || '',
        hypothesis: data.hypothesis || '',
        protocol: data.protocol || '',
        expected_outcomes: data.expected_outcomes || '',
        success_criteria: data.success_criteria || '',
        analysis_plan: data.analysis_plan || '',
        amendment_reason: data.amendment_reason || ''
      });
    }
  }, [data]);

  if (isLoading || !data) return <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateMut.mutateAsync({
        preregId,
        data: form
      });
      queryClient.invalidateQueries({ queryKey: getProjectPreRegistrationsQueryKey(data.project_id) });
      queryClient.invalidateQueries({ queryKey: ['prereg', preregId] });
      toast({ title: "Draft saved" });
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleRegister = async () => {
    setRegistering(true);
    try {
      // auto-save first
      await updateMut.mutateAsync({ preregId, data: form });
      await registerMut.mutateAsync({ preregId });
      queryClient.invalidateQueries({ queryKey: getProjectPreRegistrationsQueryKey(data.project_id) });
      toast({ title: "Pre-registration registered", description: "The document is now frozen." });
      onBack();
    } catch (err: any) {
      toast({ title: "Registration failed", description: apiErrorMessage(err, "The document could not be registered."), variant: "destructive" });
      setConfirmRegister(false);
    } finally {
      setRegistering(false);
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawReason.trim()) return;
    try {
      await withdrawMut.mutateAsync({ preregId, data: { reason: withdrawReason } });
      queryClient.invalidateQueries({ queryKey: getProjectPreRegistrationsQueryKey(data.project_id) });
      toast({ title: "Draft withdrawn" });
      onBack();
    } catch (err: any) {
      toast({ title: "Withdraw failed", description: apiErrorMessage(err, "The document could not be withdrawn."), variant: "destructive" });
    }
  };

  const isAmendment = !!data.supersedes_id;

  return (
    <div className="vls-reading-surface rounded-xl border border-border p-6 sm:p-8 animate-in fade-in zoom-in-95 duration-200">
      <div className="flex items-center gap-4 mb-8">
        <button onClick={onBack} className="p-2 -ml-2 rounded-lg hover:bg-muted/50 text-muted-foreground transition-colors">
          <ChevronRight className="w-5 h-5 rotate-180" />
        </button>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold px-2 py-0.5 rounded bg-primary/10 text-primary">DRAFT</span>
            <span className="text-sm font-medium text-muted-foreground">Version {data.version}</span>
            {isAmendment && <span className="text-xs font-bold px-2 py-0.5 rounded bg-secondary/10 text-secondary">AMENDMENT</span>}
          </div>
          <h2 className="text-2xl font-display font-bold">Edit Pre-registration</h2>
        </div>
      </div>

      <div className="space-y-6">
        {isAmendment && (
          <div className="space-y-2">
            <label className="text-sm font-bold text-foreground">Amendment Reason <span className="text-destructive">*</span></label>
            <p className="text-xs text-muted-foreground mb-2">Explain why you are amending the registered protocol.</p>
            <textarea
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 min-h-[80px]"
              value={form.amendment_reason}
              onChange={e => setForm({...form, amendment_reason: e.target.value})}
              placeholder="e.g. Updating protocol due to new findings..."
            />
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-bold text-foreground">Title <span className="text-destructive">*</span></label>
          <input
            type="text"
            className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50"
            value={form.title}
            onChange={e => setForm({...form, title: e.target.value})}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-sm font-bold text-foreground">Hypothesis</label>
            <textarea
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 min-h-[120px]"
              value={form.hypothesis}
              onChange={e => setForm({...form, hypothesis: e.target.value})}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-foreground">Protocol</label>
            <textarea
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 min-h-[120px]"
              value={form.protocol}
              onChange={e => setForm({...form, protocol: e.target.value})}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-foreground">Expected Outcomes</label>
            <textarea
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 min-h-[120px]"
              value={form.expected_outcomes}
              onChange={e => setForm({...form, expected_outcomes: e.target.value})}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-foreground">Success Criteria</label>
            <textarea
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 min-h-[120px]"
              value={form.success_criteria}
              onChange={e => setForm({...form, success_criteria: e.target.value})}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-bold text-foreground">Analysis Plan</label>
            <textarea
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 min-h-[120px]"
              value={form.analysis_plan}
              onChange={e => setForm({...form, analysis_plan: e.target.value})}
            />
          </div>
        </div>

        <div className="pt-6 border-t border-border flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowWithdraw(true)}
              className="text-sm font-medium text-destructive hover:bg-destructive/10 px-4 py-2 rounded-lg transition-colors"
            >
              Withdraw Draft
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving || registering}
              className="bg-muted text-muted-foreground hover:text-foreground px-5 py-2.5 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
              Save Draft
            </button>

            {confirmRegister ? (
              <div className="flex items-center gap-2 p-2 bg-destructive/10 border border-destructive/30 rounded-lg">
                <span className="text-xs font-bold text-destructive px-2">Freeze forever?</span>
                <button
                  onClick={() => setConfirmRegister(false)}
                  className="px-3 py-1.5 text-xs font-bold rounded bg-background border border-border"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRegister}
                  disabled={registering}
                  className="px-4 py-1.5 text-xs font-bold rounded bg-destructive text-destructive-foreground"
                >
                  {registering ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm Registration"}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmRegister(true)}
                disabled={saving || !form.title || (isAmendment && !form.amendment_reason)}
                className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-bold hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <Lock className="w-4 h-4" />
                Register & Freeze
              </button>
            )}
          </div>
        </div>

        {showWithdraw && (
          <div className="mt-6 p-6 border border-destructive/30 bg-destructive/5 rounded-xl space-y-4">
            <h4 className="font-bold text-destructive flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Withdraw Draft
            </h4>
            <p className="text-sm text-muted-foreground">Provide a reason for withdrawing this draft. This cannot be undone.</p>
            <input
              type="text"
              placeholder="Reason for withdrawal..."
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-destructive/50"
              value={withdrawReason}
              onChange={e => setWithdrawReason(e.target.value)}
            />
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowWithdraw(false)} className="px-4 py-2 text-sm font-medium hover:bg-muted/50 rounded-lg">Cancel</button>
              <button onClick={handleWithdraw} disabled={!withdrawReason.trim()} className="bg-destructive text-destructive-foreground px-4 py-2 text-sm font-bold rounded-lg disabled:opacity-50">Withdraw</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
