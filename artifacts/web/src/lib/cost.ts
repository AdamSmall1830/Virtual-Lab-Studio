import type { RunOut } from '@/api';

/**
 * A run is "unpriced" when the provider actually consumed tokens but the
 * recorded cost is 0 and the run is NOT a demo. This happens when a provider
 * model has no pricing configured: the adapter records cost 0, which is
 * otherwise indistinguishable from a genuinely free ($0.00) run.
 *
 * Demo runs are genuinely $0 and keep showing "$0.00" alongside their demo
 * badge, so they are explicitly excluded here.
 */
export function isUnpricedRun(
  run: Pick<RunOut, 'input_tokens' | 'output_tokens' | 'actual_cost_usd' | 'demo_mode'>,
): boolean {
  const tokens = (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
  const cost = Number(run.actual_cost_usd ?? 0);
  return tokens > 0 && cost === 0 && !run.demo_mode;
}

/**
 * The hint shown for an unpriced run — explains why no cost is displayed so a
 * missing price is never mistaken for a free run.
 */
export const UNPRICED_COST_HINT =
  'No pricing configured for this model — tokens were used but cost cannot be computed.';

/** The placeholder rendered in place of a dollar amount for an unpriced run. */
export const UNPRICED_COST_DISPLAY = '—';

/**
 * Formats a run's actual cost for display. Returns either a "$X.XX" string or,
 * for unpriced runs, the placeholder "—". Use {@link isUnpricedRun} to decide
 * whether to attach the {@link UNPRICED_COST_HINT} tooltip.
 */
export function formatRunCost(
  run: Pick<RunOut, 'input_tokens' | 'output_tokens' | 'actual_cost_usd' | 'demo_mode'>,
): string {
  if (isUnpricedRun(run)) return UNPRICED_COST_DISPLAY;
  return `$${Number(run.actual_cost_usd ?? 0).toFixed(2)}`;
}
