import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMembers, getMembersQueryKey,
  useUpdateMember, useRemoveMember,
  useInvitations, getInvitationsQueryKey,
  useCreateInvitation, useRevokeInvitation
} from '@/api';
import { useSession } from '@/api/session';
import { apiErrorMessage } from '@/lib/api-error';
import { Loader2, Plus, X, Check, Copy, Trash2 } from 'lucide-react';
import type { MemberOut, MemberUpdateIn, InvitationCreateIn } from '@/api';

/**
 * The workspace roles, least to most privileged. This mirrors ROLE_ORDER in
 * backend/app/security.py; the server rejects anything outside this set, and
 * refuses 'owner' on an invitation.
 */
const ROLES: { value: string; label: string; hint: string }[] = [
  { value: 'viewer', label: 'Viewer', hint: 'Read runs and results' },
  { value: 'reviewer', label: 'Reviewer', hint: 'Review and sign off on runs' },
  { value: 'researcher', label: 'Researcher', hint: 'Design and launch runs' },
  { value: 'admin', label: 'Admin', hint: 'Manage the workspace and its team' },
  { value: 'owner', label: 'Owner', hint: 'Full control, including billing' },
];

const INVITABLE_ROLES = ROLES.filter((r) => r.value !== 'owner');

function roleLabel(role: string): string {
  return ROLES.find((r) => r.value === role)?.label ?? role;
}

function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '$0.00';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function SpendDisplay({ current, limit }: { current: string, limit: string | null }) {
  const c = parseFloat(current) || 0;
  if (limit === null) {
    return <span className="text-sm text-muted-foreground whitespace-nowrap">{formatMoney(current)} / No limit</span>;
  }
  const l = parseFloat(limit) || 0;
  const ratio = l > 0 ? c / l : 1;
  const isOver = ratio >= 1;
  const isApproaching = ratio >= 0.8 && !isOver;

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <span className={`text-sm ${isOver ? 'text-destructive font-medium' : isApproaching ? 'text-amber-600 font-medium dark:text-amber-500' : 'text-muted-foreground'}`}>
        {formatMoney(current)} / {formatMoney(limit)}
      </span>
      {isOver && <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" title="Over limit" />}
      {isApproaching && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="Approaching limit" />}
    </div>
  );
}

function MemberRow({ member, workspaceId, canManage, isMe }: { member: MemberOut, workspaceId: string, canManage: boolean, isMe: boolean }) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(member.role);
  const [hasLimit, setHasLimit] = useState(member.spend_limit_usd !== null);
  const [limit, setLimit] = useState(member.spend_limit_usd || '');
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const updateMut = useUpdateMember();
  const removeMut = useRemoveMember();

  const onSave = async () => {
    setError(null);
    try {
       const data: MemberUpdateIn = {};
       if (role !== member.role) {
         data.role = role;
       }

       const originalHasLimit = member.spend_limit_usd !== null;
       const originalLimit = member.spend_limit_usd || '';
       if (hasLimit !== originalHasLimit || (hasLimit && limit !== originalLimit)) {
         data.set_spend_limit = true;
         data.spend_limit_usd = hasLimit ? (parseFloat(limit) || 0) : null;
       }

       if (Object.keys(data).length === 0) {
         setEditing(false);
         return;
       }

       await updateMut.mutateAsync({ workspaceId, memberId: member.user_id, data });
       await queryClient.invalidateQueries({ queryKey: getMembersQueryKey(workspaceId) });
       setEditing(false);
    } catch (err) {
       setError(apiErrorMessage(err, 'That change could not be saved.'));
    }
  };

  const onRemove = async () => {
    if (!window.confirm(`Remove ${member.email} from the workspace?`)) return;
    try {
      await removeMut.mutateAsync({ workspaceId, memberId: member.user_id });
      await queryClient.invalidateQueries({ queryKey: getMembersQueryKey(workspaceId) });
    } catch (err) {
      alert(apiErrorMessage(err, 'That change could not be saved.'));
    }
  };

  if (editing) {
    return (
      <div className="p-4 border-b last:border-b-0 space-y-4 bg-muted/30">
         <div className="flex justify-between items-center">
           <span className="font-medium text-sm">{member.email}</span>
           <button onClick={() => { setEditing(false); setError(null); }} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
         </div>
         <div className="grid sm:grid-cols-2 gap-4">
           <label className="space-y-1.5 text-xs">
             <span className="text-muted-foreground font-medium">Role</span>
             <select value={role} onChange={e => setRole(e.target.value)} className="w-full border bg-transparent px-3 py-1.5 text-sm rounded-lg border-border focus:ring-1 focus:ring-ring outline-none">
               {ROLES.map((r) => (
                 <option key={r.value} value={r.value}>{r.label} — {r.hint}</option>
               ))}
             </select>
           </label>
           <div className="space-y-1.5 text-xs">
             <span className="text-muted-foreground font-medium">Monthly Spend Limit</span>
             <div className="flex items-center gap-3 h-9">
               <label className="flex items-center gap-1.5 shrink-0 text-sm">
                 <input type="checkbox" checked={hasLimit} onChange={e => setHasLimit(e.target.checked)} className="rounded border-input" />
                 Cap (USD)
               </label>
               {hasLimit && (
                 <input type="number" step="1" min="0" value={limit} onChange={e => setLimit(e.target.value)} className="w-full border bg-transparent px-3 py-1.5 text-sm rounded-lg border-border focus:ring-1 focus:ring-ring outline-none" placeholder="100" />
               )}
             </div>
           </div>
         </div>
         {error && <div className="text-xs text-destructive">{error}</div>}
         <div className="flex justify-between items-center pt-2">
           <button onClick={onRemove} className="text-xs text-destructive hover:underline disabled:opacity-50 flex items-center gap-1" disabled={isMe}>
             <Trash2 className="w-3.5 h-3.5" /> Remove Member
           </button>
           <button onClick={onSave} disabled={updateMut.isPending} className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg disabled:opacity-50">
             {updateMut.isPending ? 'Saving...' : 'Save Changes'}
           </button>
         </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_100px_140px_60px] gap-4 items-center p-4 border-b last:border-b-0 hover:bg-muted/10 transition-colors">
      <div className="min-w-0">
        <div className="font-medium text-sm truncate flex items-center gap-2">
          {member.display_name || member.email}
          {isMe && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary uppercase tracking-wider font-semibold">You</span>}
        </div>
        {member.display_name && <div className="text-xs text-muted-foreground truncate">{member.email}</div>}
      </div>
      <div className="text-sm text-muted-foreground">{roleLabel(member.role)}</div>
      <SpendDisplay current={member.current_month_spend_usd} limit={member.spend_limit_usd} />
      <div className="text-right">
        {canManage && (
          <button onClick={() => setEditing(true)} className="text-xs font-medium text-muted-foreground hover:text-foreground">Edit</button>
        )}
      </div>
    </div>
  );
}

function CreateInviteForm({ workspaceId, onCancel, onCreated }: { workspaceId: string, onCancel: () => void, onCreated: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('researcher');
  const [hasLimit, setHasLimit] = useState(false);
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMut = useCreateInvitation();
  const queryClient = useQueryClient();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const data: InvitationCreateIn = { email, role };
      if (hasLimit) {
        data.spend_limit_usd = parseFloat(limit) || 0;
      }
      const res = await createMut.mutateAsync({ workspaceId, data });
      await queryClient.invalidateQueries({ queryKey: getInvitationsQueryKey(workspaceId) });
      onCreated((res as any).token);
    } catch (err) {
      setError(apiErrorMessage(err, 'That change could not be saved.'));
    }
  }

  return (
    <form onSubmit={onSubmit} className="p-4 border rounded-xl bg-background space-y-4 mb-4">
      <h3 className="font-semibold text-sm">Send Invitation</h3>
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="space-y-1.5 text-xs">
          <span className="text-muted-foreground font-medium">Email address</span>
          <input type="email" required value={email} onChange={e => setEmail(e.target.value)} className="w-full border bg-transparent px-3 py-1.5 text-sm rounded-lg border-border focus:ring-1 focus:ring-ring outline-none" placeholder="colleague@example.com" />
        </label>
        <label className="space-y-1.5 text-xs">
          <span className="text-muted-foreground font-medium">Role</span>
          <select value={role} onChange={e => setRole(e.target.value)} className="w-full border bg-transparent px-3 py-1.5 text-sm rounded-lg border-border focus:ring-1 focus:ring-ring outline-none">
            {INVITABLE_ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label} — {r.hint}</option>
            ))}
          </select>
        </label>
        <div className="space-y-1.5 text-xs sm:col-span-2">
          <span className="text-muted-foreground font-medium">Monthly Spend Limit</span>
          <div className="flex items-center gap-3 h-9">
            <label className="flex items-center gap-1.5 shrink-0 text-sm">
              <input type="checkbox" checked={hasLimit} onChange={e => setHasLimit(e.target.checked)} className="rounded border-input" />
              Cap (USD)
            </label>
            {hasLimit && (
              <input type="number" step="1" min="0" value={limit} onChange={e => setLimit(e.target.value)} className="w-full max-w-[200px] border bg-transparent px-3 py-1.5 text-sm rounded-lg border-border focus:ring-1 focus:ring-ring outline-none" placeholder="100" />
            )}
          </div>
        </div>
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={createMut.isPending} className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg disabled:opacity-50">
          {createMut.isPending ? 'Sending...' : 'Create Invite'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 border rounded-lg text-sm bg-background hover:bg-muted">Cancel</button>
      </div>
    </form>
  )
}

export default function TeamTab({ workspaceId }: { workspaceId: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  
  const { data: members, isLoading: membersLoading } = useMembers(workspaceId, {
    query: { enabled: !!workspaceId, queryKey: getMembersQueryKey(workspaceId) }
  });
  
  const { data: invitations, isLoading: invitesLoading } = useInvitations(workspaceId, {
    query: { enabled: !!workspaceId, queryKey: getInvitationsQueryKey(workspaceId) }
  });
  
  const revokeMut = useRevokeInvitation();

  const [adding, setAdding] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const roleOrder: Record<string, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };
  const myRole = members?.find(m => m.user_id === user?.id)?.role ?? 'viewer';
  const canManage = roleOrder[myRole] >= roleOrder['admin'];

  const onRevoke = async (invId: string) => {
    if (!window.confirm('Revoke this invitation? It will no longer be usable.')) return;
    try {
      await revokeMut.mutateAsync({ workspaceId, invitationId: invId });
      await queryClient.invalidateQueries({ queryKey: getInvitationsQueryKey(workspaceId) });
    } catch (err) {
      alert(apiErrorMessage(err, 'That change could not be saved.'));
    }
  }

  if (membersLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading team...</div>;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      <div className="vls-reading-surface rounded-xl border overflow-hidden shadow-sm">
        <div className="p-4 border-b bg-muted/20 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-display font-semibold">Team Members</h2>
            <p className="text-xs text-muted-foreground">People with access to this workspace.</p>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_100px_140px_60px] gap-4 px-4 py-2 bg-muted/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b">
          <div>User</div>
          <div>Role</div>
          <div>Spend (Cur / Limit)</div>
          <div className="text-right">Actions</div>
        </div>
        <div className="divide-y divide-border">
          {members?.map(m => (
            <MemberRow key={m.user_id} member={m} workspaceId={workspaceId} canManage={canManage} isMe={m.user_id === user?.id} />
          ))}
          {members?.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No members found.</div>}
        </div>
      </div>

      <div className="vls-reading-surface rounded-xl border overflow-hidden shadow-sm">
        <div className="p-4 border-b bg-muted/20 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-display font-semibold">Pending Invitations</h2>
            <p className="text-xs text-muted-foreground">Invitations that have not yet been accepted.</p>
          </div>
          {canManage && !adding && !createdToken && (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-primary text-primary-foreground font-medium shadow-sm hover:opacity-90 transition-opacity">
              <Plus className="w-4 h-4" /> Invite Member
            </button>
          )}
        </div>

        <div className="p-4">
          {adding && <CreateInviteForm workspaceId={workspaceId} onCancel={() => setAdding(false)} onCreated={t => { setAdding(false); setCreatedToken(t); }} />}

          {createdToken && (
            <div className="mb-4 p-4 border rounded-xl bg-emerald-500/10 border-emerald-500/20 space-y-3 animate-in fade-in zoom-in-95">
              <h3 className="font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                <Check className="w-4 h-4" /> Invitation created successfully
              </h3>
              <p className="text-sm text-emerald-600 dark:text-emerald-300">Share this secure link with the invitee. <strong>It will not be shown again.</strong></p>
              <div className="flex gap-2">
                 <input readOnly value={`${window.location.origin}/app/invite?token=${createdToken}`} className="w-full border bg-background/50 px-3 py-1.5 text-sm rounded-lg outline-none font-mono" onClick={e => e.currentTarget.select()} />
                 <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/app/invite?token=${createdToken}`)} className="px-3 py-1.5 bg-background border rounded-lg text-xs hover:bg-muted flex items-center gap-1.5 font-medium shadow-sm shrink-0">
                   <Copy className="w-3.5 h-3.5" /> Copy
                 </button>
              </div>
              <button onClick={() => setCreatedToken(null)} className="px-4 py-2 bg-emerald-600 text-white font-medium rounded-lg text-sm shadow-sm hover:bg-emerald-700 transition-colors">Done</button>
            </div>
          )}

          {invitesLoading ? (
            <div className="py-8 flex justify-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /></div>
          ) : invitations?.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground border rounded-lg border-dashed bg-muted/10">
              No pending invitations.
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <div className="grid grid-cols-[minmax(0,1fr)_100px_100px_80px] gap-4 px-4 py-2 bg-muted/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b">
                <div>Email</div>
                <div>Role</div>
                <div>Status</div>
                <div className="text-right">Actions</div>
              </div>
              <div className="divide-y divide-border">
                {invitations?.map(inv => (
                  <div key={inv.id} className="grid grid-cols-[minmax(0,1fr)_100px_100px_80px] gap-4 items-center p-4 hover:bg-muted/10 transition-colors">
                    <div className="font-medium text-sm truncate">{inv.email}</div>
                    <div className="text-sm text-muted-foreground">{roleLabel(inv.role)}</div>
                    <div className="text-xs">
                      {inv.status === 'pending' ? <span className="text-amber-600 dark:text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-md font-medium">Pending</span> : <span className="capitalize">{inv.status}</span>}
                    </div>
                    <div className="text-right">
                      {canManage && inv.status === 'pending' && (
                        <button onClick={() => onRevoke(inv.id)} disabled={revokeMut.isPending} className="text-xs text-destructive hover:underline font-medium disabled:opacity-50">Revoke</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
