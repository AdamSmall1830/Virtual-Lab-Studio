import React from 'react';

/**
 * Marks content that was produced by a demo (simulated) run. Demo output is
 * machine-fabricated and must never be read or cited as a real result, so this
 * badge is shown anywhere demo summaries are presented as authoritative.
 *
 * Mirrors the DEMO badge on the run detail header.
 */
export function DemoBadge({ className = '' }: { className?: string }) {
  return (
    <span
      data-testid="badge-demo"
      title="Simulated demo output — not a real result. Do not cite."
      className={`bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded text-xs font-mono font-bold ${className}`}
    >
      DEMO
    </span>
  );
}
