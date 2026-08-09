import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { useSession } from '@/api/session';
import { apiErrorMessage } from '@/lib/api-error';
import { previewInvitation, useAcceptInvitation } from '@/api';
import { Loader2, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export default function InviteAccept() {
  const [, setLocation] = useLocation();
  const search = window.location.search;
  const token = new URLSearchParams(search).get('token');
  const { user, isLoading: sessionLoading } = useSession();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);

  // A query over a POST endpoint: reading an invitation has no side effects, but
  // the token must travel in the body rather than the request line so it stays
  // out of server access logs. The token is deliberately not part of the query
  // key — keying on a credential would park it in the client cache.
  const { data: preview, isLoading: previewLoading, isError: previewError, error: previewErrorData } = useQuery({
    queryKey: ['invitation-preview'],
    queryFn: () => previewInvitation({ token: token || '' }),
    enabled: !!token && !sessionLoading,
    retry: false,
    gcTime: 0,
  });

  const acceptMut = useAcceptInvitation();

  if (!token) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-muted/20">
        <div className="max-w-md w-full p-8 border rounded-2xl bg-card shadow-sm text-center space-y-4">
          <ShieldAlert className="w-12 h-12 text-destructive mx-auto" />
          <h1 className="text-xl font-display font-semibold">Invalid Invitation Link</h1>
          <p className="text-sm text-muted-foreground">This link is missing an invitation token.</p>
          <button onClick={() => setLocation('/')} className="mt-4 px-6 py-2.5 border rounded-xl text-sm hover:bg-muted font-medium transition-colors">Return to Home</button>
        </div>
      </div>
    );
  }

  if (sessionLoading || previewLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-muted/20">
        <div className="flex flex-col items-center gap-4 text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin" />
          <p className="text-sm font-medium">Verifying invitation...</p>
        </div>
      </div>
    );
  }

  if (previewError) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-muted/20">
        <div className="max-w-md w-full p-8 border rounded-2xl bg-card shadow-sm text-center space-y-4">
          <ShieldAlert className="w-12 h-12 text-destructive mx-auto" />
          <h1 className="text-xl font-display font-semibold">Invitation Unavailable</h1>
          <p className="text-sm text-muted-foreground">{apiErrorMessage(previewErrorData, 'This invitation could not be opened.') || 'This invitation may have expired or been revoked.'}</p>
          <button onClick={() => setLocation('/')} className="mt-4 px-6 py-2.5 border rounded-xl text-sm hover:bg-muted font-medium transition-colors">Return to Home</button>
        </div>
      </div>
    );
  }

  if (!preview) return null;

  const onAccept = async () => {
    setError(null);
    try {
      await acceptMut.mutateAsync({ data: { token } });
      await queryClient.invalidateQueries();
      window.location.href = '/app';
    } catch (err) {
      setError(apiErrorMessage(err, 'This invitation could not be opened.'));
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-muted/20 animate-in fade-in duration-300">
      <div className="max-w-md w-full p-8 border rounded-2xl bg-card shadow-lg space-y-6">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 bg-primary/10 text-primary flex items-center justify-center rounded-full mx-auto mb-2">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-display font-bold">Workspace Invitation</h1>
          <p className="text-muted-foreground text-sm">
            You have been invited to join <strong>{preview.workspace_name}</strong> as a <span className="capitalize font-medium text-foreground">{preview.role}</span>.
          </p>
          {preview.inviter_display_name && (
            <p className="text-xs text-muted-foreground">Invited by {preview.inviter_display_name}</p>
          )}
        </div>

        <div className="p-4 bg-muted/30 border rounded-xl space-y-3">
          <div className="text-sm flex justify-between gap-4">
            <span className="text-muted-foreground shrink-0">Signed in as:</span>
            <span className="font-medium truncate" title={user?.email}>{user?.email}</span>
          </div>
          <div className="text-sm flex justify-between gap-4">
            <span className="text-muted-foreground shrink-0">Valid until:</span>
            <span className="font-medium">{new Date(preview.expires_at).toLocaleDateString()}</span>
          </div>
        </div>

        {!preview.email_matches ? (
          <div className="p-4 border rounded-xl bg-destructive/10 border-destructive/20 text-destructive text-sm space-y-2">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Email Mismatch
            </div>
            <p className="leading-relaxed">
              This invitation was sent to a different email address. You are currently signed in as <strong className="break-all">{user?.email}</strong>. 
              The server will reject this acceptance. Please sign in with the correct account.
            </p>
          </div>
        ) : error ? (
          <div className="p-4 border rounded-xl bg-destructive/10 border-destructive/20 text-destructive text-sm space-y-2">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Acceptance Failed
            </div>
            <p>{error}</p>
          </div>
        ) : null}

        <div className="pt-4 space-y-3">
          <button
            onClick={onAccept}
            disabled={!preview.email_matches || acceptMut.isPending}
            className="w-full py-2.5 bg-primary text-primary-foreground font-medium rounded-xl disabled:opacity-50 hover:bg-primary/90 transition-colors shadow-sm"
          >
            {acceptMut.isPending ? 'Accepting...' : 'Accept Invitation'}
          </button>
          
          <button 
            onClick={() => setLocation('/')} 
            className="w-full py-2.5 border bg-background text-foreground font-medium rounded-xl hover:bg-muted transition-colors"
          >
            Decline & Return Home
          </button>
        </div>
      </div>
    </div>
  );
}
