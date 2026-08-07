import React from 'react';
import { Network, Info, AlertTriangle, FlaskConical } from 'lucide-react';
import { CEILING_DISCLAIMER, formatDuration, formatUsd } from '@/lib/recursive';
import type { RecursiveExecutionEstimateOut } from '@/api';

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
        {label}
      </div>
      <div className="font-mono text-sm font-semibold mt-0.5">{value}</div>
      {note && <div className="text-[10px] text-muted-foreground mt-0.5">{note}</div>}
    </div>
  );
}

/**
 * The recursive half of the pre-launch estimate.
 *
 * It is kept visually separate from the standard estimate rather than summed
 * into it. The standard figures are a projection of work this server will do;
 * these are hard ceilings on work another machine may do. Adding them would
 * produce a single number that means neither thing.
 */
export function ValidationRecursiveSection({
  estimate,
  isSimulation = false,
}: {
  estimate: RecursiveExecutionEstimateOut;
  /**
   * True when the draft's standard provider is the demo one. A simulated run
   * dispatches no work to a worker, so these ceilings describe a shape that
   * will never be executed — the panel has to say so itself rather than lean
   * on the "Simulation" banner sitting above it.
   */
  isSimulation?: boolean;
}) {
  return (
    <section
      aria-labelledby="recursive-estimate-heading"
      className="rounded-xl border border-primary/30 bg-primary/[0.04] p-4 space-y-3"
    >
      <div className="flex items-start gap-2">
        <Network className="w-4 h-4 text-primary mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0">
          <h4 id="recursive-estimate-heading" className="text-sm font-bold">
            Recursive execution — upper bounds
            {isSimulation && (
              <span className="ml-2 align-middle inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                <FlaskConical className="w-3 h-3" aria-hidden />
                Simulated
              </span>
            )}
          </h4>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            {CEILING_DISCLAIMER}
          </p>
        </div>
      </div>

      {isSimulation && (
        <p className="text-[11px] flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
          <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          This is a simulated run, so nothing will be sent to your machine and no model will be
          called. The bounds below describe the shape the run would have had; treat them as a
          rehearsal, not as a record.
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Figure
          label="Recursive turns"
          value={String(estimate.recursive_turn_count)}
          note="Seats running on your machine"
        />
        <Figure label="Max agent turns" value={`≤ ${estimate.max_agent_turns}`} />
        <Figure label="Max children / turn" value={`≤ ${estimate.max_children_per_turn}`} />
        <Figure label="Max depth" value={`≤ ${estimate.max_depth}`} />
        <Figure label="Max tokens" value={`≤ ${estimate.max_tokens.toLocaleString()}`} />
        <Figure label="Max runtime" value={`≤ ${formatDuration(estimate.max_runtime_seconds)}`} />
      </div>

      <div className="pt-3 border-t border-primary/20 flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold">Cost ceiling</span>
        <span className="font-mono text-sm font-bold">
          {estimate.max_cost_usd == null ? 'No ceiling set' : `≤ ${formatUsd(estimate.max_cost_usd)}`}
        </span>
      </div>

      {!estimate.pricing_complete && (
        <p className="text-[11px] flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
          <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          The worker reports no pricing for at least one selected model, so this cost ceiling is
          incomplete. Self-hosted models are often unpriced; that is shown as unknown rather than
          as zero.
        </p>
      )}

      {!estimate.workers_online && (
        <p className="text-[11px] flex items-start gap-1.5 text-destructive" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          No recursive worker is online right now. The recursive seats will wait for a worker
          rather than run on a standard provider.
        </p>
      )}
    </section>
  );
}
