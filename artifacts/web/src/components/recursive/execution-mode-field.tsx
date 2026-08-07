import React from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, Network } from 'lucide-react';
import {
  BETA_DISCLAIMER,
  RECURSIVE_BOUNDS,
  availabilityBlocker,
  clampBound,
  formatDuration,
  formatRelativeTime,
  modelPricingComplete,
  recursiveConfigProblems,
  type EligibleWorker,
  type RecursiveAvailability,
  type RecursiveDraftConfig,
} from '@/lib/recursive';

export type ExecutionMode = 'standard' | 'recursive_rlm';

const NUMERIC_FIELDS: {
  key: 'max_children' | 'max_depth' | 'max_agent_turns' | 'max_runtime_seconds';
  label: string;
  hint: string;
}[] = [
  { key: 'max_children', label: 'Child agents per turn', hint: 'Most the coordinator may spawn.' },
  { key: 'max_depth', label: 'Depth', hint: 'How far children may themselves delegate.' },
  { key: 'max_agent_turns', label: 'Agent turns', hint: 'Most internal steps before it must stop.' },
  { key: 'max_runtime_seconds', label: 'Runtime ceiling (s)', hint: 'Hard stop for this turn.' },
];

function Notice({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn' | 'error';
  title: string;
  children?: React.ReactNode;
}) {
  const cls =
    tone === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : tone === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-border bg-muted/30 text-muted-foreground';
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={`rounded-lg border p-2.5 text-[11px] leading-relaxed ${cls}`} role={tone === 'error' ? 'alert' : undefined}>
      <div className="flex items-start gap-1.5">
        <Icon className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
        <div className="min-w-0">
          <div className="font-semibold">{title}</div>
          {children && <div className="mt-0.5 opacity-90">{children}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-participant runtime selector.
 *
 * The rule this component exists to enforce: a participant the researcher set
 * to recursive is *never* quietly reverted. When the runtime becomes
 * unavailable the selection stays put and the card reports a blocking problem,
 * because running that seat on a standard provider instead would be a
 * different experiment than the one that was configured.
 */
export function ExecutionModeField({
  mode,
  config,
  availability,
  onModeChange,
  onConfigChange,
  idPrefix,
  className,
  standardLabel,
}: {
  mode: ExecutionMode;
  config: RecursiveDraftConfig | null;
  availability: RecursiveAvailability;
  onModeChange: (mode: ExecutionMode) => void;
  onConfigChange: (config: RecursiveDraftConfig) => void;
  idPrefix: string;
  className?: string;
  /** What the standard option runs on, so the trade-off is legible. */
  standardLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const blocker = availabilityBlocker(availability);
  const eligible: EligibleWorker[] = availability.state === 'ready' ? availability.workers : [];
  const isRecursive = mode === 'recursive_rlm';

  const chosen = config ? eligible.find((e) => e.worker.id === config.requested_worker_id) : undefined;
  const problems = isRecursive && config ? recursiveConfigProblems(config, eligible) : [];

  const update = (patch: Partial<RecursiveDraftConfig>) => {
    if (!config) return;
    onConfigChange({ ...config, ...patch });
  };

  return (
    <div className={`pt-4 border-t border-border/50 ${className ?? 'mt-4'}`}>
      <label
        htmlFor={`${idPrefix}-execution-mode`}
        className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-2 font-bold"
      >
        Execution runtime
      </label>
      <select
        id={`${idPrefix}-execution-mode`}
        value={mode}
        onChange={(e) => onModeChange(e.target.value as ExecutionMode)}
        className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 font-semibold focus:outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer"
      >
        <option value="standard">{standardLabel ?? 'Standard agent'}</option>
        <option value="recursive_rlm" disabled={availability.state !== 'ready' && !isRecursive}>
          Recursive agent (beta){availability.state !== 'ready' ? ' — unavailable' : ''}
        </option>
      </select>

      {!isRecursive && blocker && availability.state !== 'loading' && (
        <p className="text-[11px] text-muted-foreground mt-1.5">{blocker}</p>
      )}

      {isRecursive && (
        <div className="mt-3 space-y-2.5">
          {blocker ? (
            <Notice tone="error" title={blocker}>
              This participant stays set to recursive execution. Nothing will be run on a standard
              provider in its place — change the runtime yourself if that is what you want.
            </Notice>
          ) : (
            <Notice tone="warn" title="Runs on your machine (beta)">
              {BETA_DISCLAIMER}
            </Notice>
          )}

          {config && (
            <>
              <div>
                <label
                  htmlFor={`${idPrefix}-worker`}
                  className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-bold"
                >
                  Worker machine
                </label>
                <select
                  id={`${idPrefix}-worker`}
                  value={config.requested_worker_id}
                  onChange={(e) => {
                    const next = eligible.find((w) => w.worker.id === e.target.value);
                    update({
                      requested_worker_id: e.target.value,
                      coordinator_model_key: next?.models[0]?.model_key ?? '',
                      child_model_key: null,
                    });
                  }}
                  className="w-full text-sm bg-background border border-border rounded-lg px-2.5 py-1.5"
                >
                  {eligible.length === 0 && <option value={config.requested_worker_id}>No worker available</option>}
                  {eligible.map((e) => (
                    <option key={e.worker.id} value={e.worker.id}>
                      {e.worker.display_name}
                    </option>
                  ))}
                </select>
                {chosen && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Last contact {formatRelativeTime(chosen.worker.last_seen_at)}
                    {chosen.worker.sandbox_mode ? ` · sandbox: ${chosen.worker.sandbox_mode}` : ''}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor={`${idPrefix}-coordinator`}
                  className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-bold"
                >
                  Coordinator model
                </label>
                <select
                  id={`${idPrefix}-coordinator`}
                  value={config.coordinator_model_key}
                  onChange={(e) => update({ coordinator_model_key: e.target.value })}
                  className="w-full text-sm bg-background border border-border rounded-lg px-2.5 py-1.5"
                >
                  {(chosen?.models ?? []).length === 0 && <option value="">No compatible model</option>}
                  {(chosen?.models ?? []).map((m) => (
                    <option key={m.model_key} value={m.model_key}>
                      {m.display_name || m.model_key}
                      {modelPricingComplete(m) ? '' : ' — no pricing reported'}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor={`${idPrefix}-child-model`}
                  className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-bold"
                >
                  Child model (optional)
                </label>
                <select
                  id={`${idPrefix}-child-model`}
                  value={config.child_model_key ?? ''}
                  onChange={(e) => update({ child_model_key: e.target.value || null })}
                  className="w-full text-sm bg-background border border-border rounded-lg px-2.5 py-1.5"
                >
                  <option value="">Same as coordinator</option>
                  {(chosen?.models ?? []).map((m) => (
                    <option key={m.model_key} value={m.model_key}>
                      {m.display_name || m.model_key}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={open}
              >
                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Limits for this participant
              </button>

              {open && (
                <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-2.5">
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Ceilings, not targets. The coordinator decides its own fan-out below them.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {NUMERIC_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label
                          htmlFor={`${idPrefix}-${f.key}`}
                          className="block text-[10px] text-muted-foreground mb-0.5"
                          title={f.hint}
                        >
                          {f.label}
                        </label>
                        <input
                          id={`${idPrefix}-${f.key}`}
                          type="number"
                          min={RECURSIVE_BOUNDS[f.key].min}
                          max={RECURSIVE_BOUNDS[f.key].max}
                          value={config[f.key]}
                          onChange={(e) => update({ [f.key]: clampBound(f.key, Number(e.target.value)) } as Partial<RecursiveDraftConfig>)}
                          className="w-full text-xs bg-background border border-border rounded-md px-2 py-1 font-mono"
                        />
                      </div>
                    ))}
                    <div>
                      <label
                        htmlFor={`${idPrefix}-max_tokens`}
                        className="block text-[10px] text-muted-foreground mb-0.5"
                      >
                        Token ceiling
                      </label>
                      <input
                        id={`${idPrefix}-max_tokens`}
                        type="number"
                        min={RECURSIVE_BOUNDS.max_tokens.min}
                        max={RECURSIVE_BOUNDS.max_tokens.max}
                        step={1000}
                        value={config.max_tokens}
                        onChange={(e) => update({ max_tokens: clampBound('max_tokens', Number(e.target.value)) })}
                        className="w-full text-xs bg-background border border-border rounded-md px-2 py-1 font-mono"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${idPrefix}-max_cost`}
                        className="block text-[10px] text-muted-foreground mb-0.5"
                      >
                        Cost ceiling (USD)
                      </label>
                      <input
                        id={`${idPrefix}-max_cost`}
                        type="number"
                        min={0}
                        step={0.5}
                        value={config.max_cost_usd ?? ''}
                        onChange={(e) =>
                          update({ max_cost_usd: e.target.value === '' ? null : Number(e.target.value) })
                        }
                        className="w-full text-xs bg-background border border-border rounded-md px-2 py-1 font-mono"
                      />
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Worst case for this seat: up to {config.max_agent_turns} turns, each spawning up to{' '}
                    {config.max_children} children, stopping after {formatDuration(config.max_runtime_seconds)}.
                  </p>
                </div>
              )}

              {problems.length > 0 && (
                <Notice tone="error" title="This recursive participant cannot launch">
                  <ul className="list-disc pl-4 space-y-0.5 mt-1">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Notice>
              )}

              <p className="text-[10px] text-muted-foreground flex items-start gap-1">
                <Network className="w-3 h-3 mt-px shrink-0" aria-hidden />
                Python and frozen-evidence search only. No web access, and this workspace never
                receives the machine's model credentials.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
