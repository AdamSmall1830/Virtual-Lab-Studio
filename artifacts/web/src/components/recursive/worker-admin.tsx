import React from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  Copy,
  Cpu,
  Info,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';
import {
  getListWorkersQueryKey,
  useCreateWorkerEnrollment,
  useDisableWorker,
  useEnableWorker,
  useRevokeWorker,
  type RecursiveWorkerEnrollmentCreatedOut,
  type RecursiveWorkerOut,
} from '@/api';
import {
  formatRelativeTime,
  recursiveModels,
  workerStatusPresentation,
  WORKER_OFFLINE_AFTER_SECONDS,
} from '@/lib/recursive';
import { StatusChip } from './status-chip';
import { useRecursiveWorkers } from './use-recursive-workers';

function errMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

function EnrollmentTokenCard({
  enrollment,
  onDismiss,
}: {
  enrollment: RecursiveWorkerEnrollmentCreatedOut;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(enrollment.enrollment_token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: 'Could not copy',
        description: 'Select the token and copy it manually.',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="rounded-xl border border-primary/40 bg-primary/[0.06] p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-primary mt-0.5 shrink-0" aria-hidden />
        <div>
          <h3 className="text-sm font-bold">
            Enrollment token for “{enrollment.requested_display_name}”
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            This is the only time the token is shown. The server keeps a hash, not the value, so it
            cannot be displayed again — mint a new one if you lose it. It expires{' '}
            {new Date(enrollment.expires_at).toLocaleString()}.
          </p>
        </div>
      </div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 font-mono text-xs bg-background border border-border rounded-lg px-3 py-2 break-all">
          {enrollment.enrollment_token}
        </code>
        <button
          onClick={copy}
          className="shrink-0 px-3 rounded-lg border border-border hover:bg-background transition-colors text-xs font-semibold inline-flex items-center gap-1.5"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="flex justify-end">
        <button
          onClick={onDismiss}
          className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          I have saved it — hide
        </button>
      </div>
    </div>
  );
}

function WorkerCard({
  worker,
  workspaceId,
  onChanged,
}: {
  worker: RecursiveWorkerOut;
  workspaceId: string;
  onChanged: () => void;
}) {
  const disable = useDisableWorker();
  const enable = useEnableWorker();
  const revoke = useRevokeWorker();
  const busy = disable.isPending || enable.isPending || revoke.isPending;

  const presentation = workerStatusPresentation(worker);
  const models = worker.model_catalog ?? [];
  const capable = recursiveModels(worker);
  const caps = worker.capabilities ?? {};

  const act = (
    mutation: { mutateAsync: (v: { workspaceId: string; workerId: string }) => Promise<unknown> },
    verb: string,
  ) => {
    void mutation
      .mutateAsync({ workspaceId, workerId: worker.id })
      .then(() => {
        toast({ title: `Worker ${verb}`, description: worker.display_name });
        onChanged();
      })
      .catch((err: unknown) => {
        toast({
          title: `Could not ${verb.replace(/d$/, '')} worker`,
          description: errMessage(err, 'The server refused the change.'),
          variant: 'destructive',
        });
      });
  };

  return (
    <div className="vls-reading-surface rounded-xl border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{worker.display_name}</span>
            <StatusChip presentation={presentation} size="xs" />
          </div>
          <div className="text-[11px] text-muted-foreground mt-1 font-mono">
            token {worker.token_prefix}… · last contact {formatRelativeTime(worker.last_seen_at)}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!worker.revoked_at && (
            <button
              onClick={() => act(worker.enabled ? disable : enable, worker.enabled ? 'disabled' : 'enabled')}
              disabled={busy}
              className="px-2.5 py-1.5 rounded-lg border border-border text-xs font-semibold hover:bg-background transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : worker.enabled ? (
                <Ban className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {worker.enabled ? 'Disable' : 'Enable'}
            </button>
          )}
          {!worker.revoked_at && (
            <button
              onClick={() => {
                if (
                  !window.confirm(
                    `Revoke “${worker.display_name}”? Its token stops working immediately and it cannot be re-enabled — the machine must enrol again.`,
                  )
                ) {
                  return;
                }
                act(revoke, 'revoked');
              }}
              disabled={busy}
              className="px-2.5 py-1.5 rounded-lg border border-destructive/40 text-destructive text-xs font-semibold hover:bg-destructive hover:text-destructive-foreground transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Revoke
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
        <div>
          <div className="text-muted-foreground">Bridge version</div>
          <div className="font-mono">{worker.adapter_version ?? '—'}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Prime Agent</div>
          <div className="font-mono">{worker.prime_agent_version ?? '—'}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Sandbox</div>
          <div className="font-mono">{worker.sandbox_mode ?? '—'}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Max children / depth</div>
          <div className="font-mono">
            {caps.max_children ?? '—'} / {caps.max_depth ?? '—'}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1.5">
          Advertised models ({capable.length} recursive-capable of {models.length})
        </div>
        {models.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">
            The worker has not published a catalogue yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <li
                key={m.model_key}
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono ${
                  m.supports_recursive_agents
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground'
                }`}
                title={
                  m.supports_recursive_agents
                    ? 'Usable for recursive execution'
                    : 'Advertised, but not marked as supporting recursive agents'
                }
              >
                <Cpu className="w-2.5 h-2.5" aria-hidden />
                {m.model_key}
                {!m.supports_recursive_agents && <span className="not-italic"> (standard only)</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {worker.last_error_safe_message && (
        <p className="text-[11px] text-destructive flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          {worker.last_error_safe_message}
        </p>
      )}
    </div>
  );
}

/**
 * Workspace administration for recursive worker machines.
 *
 * Enrollment is one-directional by design: this screen mints a token, and the
 * machine presents it. Nothing here ever asks for, stores or displays the
 * machine's own model credentials, its host name or a filesystem path — the
 * server has no field for any of those.
 */
export function RecursiveWorkerAdmin({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const { availability, workers, isLoading, refetch } = useRecursiveWorkers(workspaceId, {
    pollMs: 15_000,
  });
  const createEnrollment = useCreateWorkerEnrollment();
  const [displayName, setDisplayName] = React.useState('');
  const [minted, setMinted] = React.useState<RecursiveWorkerEnrollmentCreatedOut | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getListWorkersQueryKey(workspaceId) });
  };

  const mint = async () => {
    const name = displayName.trim();
    if (!name) return;
    try {
      const created = await createEnrollment.mutateAsync({
        workspaceId,
        data: { display_name: name },
      });
      setMinted(created);
      setDisplayName('');
      invalidate();
    } catch (err) {
      toast({
        title: 'Could not create an enrollment token',
        description: errMessage(err, 'The server refused the request.'),
        variant: 'destructive',
      });
    }
  };

  if (availability.state === 'unsupported' || availability.state === 'forbidden') {
    return (
      <div className="vls-reading-surface rounded-xl p-6 border space-y-3">
        <h2 className="text-lg font-display font-semibold border-b border-border pb-2">
          Recursive workers
        </h2>
        <div className="flex items-start gap-2 text-sm">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <div className="font-semibold">{availability.headline}</div>
            <p className="text-muted-foreground text-[13px] mt-1 leading-relaxed">
              {availability.detail}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="vls-reading-surface rounded-xl p-6 border space-y-4">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-2">
          <h2 className="text-lg font-display font-semibold flex items-center gap-2">
            <Server className="w-4 h-4 text-primary" aria-hidden />
            Recursive workers
          </h2>
          <button
            onClick={refetch}
            className="text-xs font-semibold text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden />
            Refresh
          </button>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed">
          A recursive participant is executed by a bridge running on a machine you control. Enrol
          that machine here, then start the bridge on it with the token below. A worker counts as
          online for {WORKER_OFFLINE_AFTER_SECONDS} seconds after each check-in.
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <label htmlFor="worker-display-name" className="sr-only">
            Name for the new worker machine
          </label>
          <input
            id="worker-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Lab workstation (RTX 3090)"
            maxLength={200}
            className="flex-1 text-sm bg-background border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            onClick={() => void mint()}
            disabled={!displayName.trim() || createEnrollment.isPending}
            className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold hover:bg-foreground/90 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {createEnrollment.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Create enrollment token
          </button>
        </div>

        {minted && <EnrollmentTokenCard enrollment={minted} onDismiss={() => setMinted(null)} />}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          Loading workers…
        </div>
      ) : availability.state === 'error' ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">
          <div className="font-semibold text-destructive">{availability.headline}</div>
          <p className="text-muted-foreground text-[13px] mt-1">{availability.detail}</p>
        </div>
      ) : workers.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Server className="w-8 h-8 mx-auto mb-3 opacity-30" aria-hidden />
          <div className="font-semibold">No machine enrolled yet</div>
          <p className="text-sm text-muted-foreground mt-1">
            Create a token above, then run the bridge on your machine with it.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {workers.map((w) => (
            <WorkerCard key={w.id} worker={w} workspaceId={workspaceId} onChanged={invalidate} />
          ))}
        </div>
      )}
    </div>
  );
}
