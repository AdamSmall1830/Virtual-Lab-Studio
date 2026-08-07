import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ValidationRecursiveSection } from './validation-recursive-section';
import type { RecursiveExecutionEstimateOut } from '@/api';

function estimate(
  over: Partial<RecursiveExecutionEstimateOut> = {},
): RecursiveExecutionEstimateOut {
  return {
    recursive_turn_count: 2,
    max_agent_turns: 8,
    max_children_per_turn: 4,
    max_depth: 2,
    max_tokens: 120000,
    max_runtime_seconds: 900,
    max_cost_usd: 3.5,
    pricing_complete: true,
    workers_online: true,
    ...over,
  } as RecursiveExecutionEstimateOut;
}

describe('ValidationRecursiveSection', () => {
  it('presents every figure as an upper bound, not a prediction', () => {
    render(<ValidationRecursiveSection estimate={estimate()} />);
    expect(screen.getByRole('heading', { name: /upper bounds/i })).toBeInTheDocument();
    expect(screen.getByText('≤ 8')).toBeInTheDocument();
    expect(screen.getByText('≤ 4')).toBeInTheDocument();
    expect(screen.getByText('≤ $3.50')).toBeInTheDocument();
  });

  it('does not describe the ceiling as an estimate or expected cost', () => {
    const { container } = render(<ValidationRecursiveSection estimate={estimate()} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/ceiling/i);
    expect(text).not.toMatch(/expected cost|estimated cost|will cost|predicted/i);
  });

  it('says there is no ceiling rather than showing zero', () => {
    render(<ValidationRecursiveSection estimate={estimate({ max_cost_usd: null })} />);
    expect(screen.getByText(/no ceiling set/i)).toBeInTheDocument();
    expect(screen.queryByText('≤ $0.00')).not.toBeInTheDocument();
  });

  it('warns when pricing is incomplete instead of implying the total is whole', () => {
    render(<ValidationRecursiveSection estimate={estimate({ pricing_complete: false })} />);
    expect(screen.getByText(/incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/rather than as zero/i)).toBeInTheDocument();
  });

  it('states plainly that no worker is online, and does not offer a fallback', () => {
    render(<ValidationRecursiveSection estimate={estimate({ workers_online: false })} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/no recursive worker is online/i);
    expect(alert.textContent).toMatch(/rather than run on a standard provider/i);
  });

  it('does not announce a worker problem when workers are online', () => {
    render(<ValidationRecursiveSection estimate={estimate()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // A simulated run dispatches nothing to a worker, so the ceilings describe a
  // shape that will never execute. The panel must say so on its own.
  it('marks the bounds as simulated when the draft uses the demo provider', () => {
    render(<ValidationRecursiveSection estimate={estimate()} isSimulation />);
    expect(screen.getByText(/^simulated$/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing will be sent to your machine/i)).toBeInTheDocument();
    expect(screen.getByText(/rehearsal, not as a record/i)).toBeInTheDocument();
  });

  it('does not call a real run simulated', () => {
    const { container } = render(<ValidationRecursiveSection estimate={estimate()} />);
    expect(container.textContent).not.toMatch(/simulat/i);
  });
});
