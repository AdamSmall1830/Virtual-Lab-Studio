import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { RecursiveAgentJobDetailOut, RunEventOut } from '@/api';

const refetch = vi.fn(() => Promise.resolve({ data: undefined }));
const treeState: {
  data: { run_id: string; jobs: RecursiveAgentJobDetailOut[] } | undefined;
  error: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
} = {
  data: { run_id: 'r1', jobs: [] },
  error: null,
  isLoading: false,
  isError: false,
  isFetching: false,
};

vi.mock('@/api', () => ({
  useRunRecursiveTree: () => ({ ...treeState, refetch }),
  getRunRecursiveTreeQueryKey: (runId: string) => ['tree', runId],
}));

// Imported after the mock so the component picks it up.
const { LiveRecursivePanel } = await import('./live-recursive-panel');

const NOW = Date.parse('2026-08-07T12:00:00Z');

function job(over: Partial<RecursiveAgentJobDetailOut['job']> = {}): RecursiveAgentJobDetailOut {
  return {
    job: {
      id: 'j1',
      run_id: 'r1',
      run_turn_id: 't1',
      worker_id: 'w1',
      status: 'running',
      model_key: 'qwen3:8b',
      child_model_key: null,
      capability_profile: 'research_read_only',
      max_children: 4,
      max_depth: 2,
      max_agent_turns: 8,
      max_tokens: 100000,
      max_runtime_seconds: 900,
      max_cost_usd: 2,
      model_call_count: 3,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.02,
      failure_code: null,
      failure_safe_message: null,
      started_at: new Date(NOW - 60000).toISOString(),
      completed_at: null,
      created_at: new Date(NOW - 90000).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      ...over,
    },
    nodes: [],
  } as unknown as RecursiveAgentJobDetailOut;
}

function event(seq: number, event_type: string, payload: Record<string, unknown> = {}): RunEventOut {
  return {
    id: `e${seq}`,
    run_id: 'r1',
    run_sequence: seq,
    event_type,
    payload,
    created_at: new Date(NOW).toISOString(),
  } as unknown as RunEventOut;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  refetch.mockClear();
  treeState.data = { run_id: 'r1', jobs: [] };
  treeState.error = null;
  treeState.isLoading = false;
  treeState.isError = false;
  treeState.isFetching = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveRecursivePanel', () => {
  it('stays out of the way for a run with no recursive turns', () => {
    const { container } = render(
      <LiveRecursivePanel runId="r1" events={[]} reconnectNonce={0} demoMode={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the deployment has no recursive runtime (404)', () => {
    treeState.data = undefined;
    treeState.error = { status: 404 };
    treeState.isError = true;
    const { container } = render(
      <LiveRecursivePanel
        runId="r1"
        events={[event(1, 'recursive.agent.started')]}
        reconnectNonce={0}
        demoMode={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the tree the server reports', () => {
    treeState.data = { run_id: 'r1', jobs: [job()] };
    render(<LiveRecursivePanel runId="r1" events={[]} reconnectNonce={0} demoMode={false} />);
    expect(screen.getByRole('heading', { name: /recursive execution/i })).toBeInTheDocument();
    expect(screen.getByText('qwen3:8b')).toBeInTheDocument();
  });

  // The tree must come from the server, never from the accumulated stream: a
  // browser that reconnected cannot know which events it missed.
  it('re-reads the tree from the server on reconnect', async () => {
    treeState.data = { run_id: 'r1', jobs: [job()] };
    const { rerender } = render(
      <LiveRecursivePanel runId="r1" events={[]} reconnectNonce={0} demoMode={false} />,
    );
    expect(refetch).not.toHaveBeenCalled();

    rerender(<LiveRecursivePanel runId="r1" events={[]} reconnectNonce={1} demoMode={false} />);
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));

    rerender(<LiveRecursivePanel runId="r1" events={[]} reconnectNonce={2} demoMode={false} />);
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(2));
  });

  it('coalesces a burst of worker events into a single re-read', async () => {
    treeState.data = { run_id: 'r1', jobs: [job()] };
    const events = [
      event(1, 'recursive.agent.started'),
      event(2, 'recursive.subagent.started'),
      event(3, 'recursive.tool.called'),
    ];
    render(<LiveRecursivePanel runId="r1" events={events} reconnectNonce={0} demoMode={false} />);

    await vi.advanceTimersByTimeAsync(2000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-read for events that have nothing to do with the tree', async () => {
    treeState.data = { run_id: 'r1', jobs: [job()] };
    render(
      <LiveRecursivePanel
        runId="r1"
        events={[event(1, 'turn.completed'), event(2, 'round.started')]}
        reconnectNonce={0}
        demoMode={false}
      />,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(refetch).not.toHaveBeenCalled();
  });

  // The warning is driven by the run's demo flag, which says nothing about who
  // executed the recursive turn, so the copy must not attribute the record to a
  // particular producer -- only deny that it is a research result.
  it('labels a demonstration run everywhere it shows recursive figures', () => {
    treeState.data = { run_id: 'r1', jobs: [job()] };
    render(<LiveRecursivePanel runId="r1" events={[]} reconnectNonce={0} demoMode />);
    expect(screen.getByText(/demonstration run/i)).toBeInTheDocument();
  });

  it('describes the limits as ceilings, not predictions', () => {
    treeState.data = { run_id: 'r1', jobs: [job()] };
    const { container } = render(
      <LiveRecursivePanel runId="r1" events={[]} reconnectNonce={0} demoMode={false} />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/ceiling|upper bound|≤/i);
    expect(text).not.toMatch(/expected cost|predicted|will use/i);
  });

  it('shows a safe failure message and never a raw one', () => {
    treeState.data = {
      run_id: 'r1',
      jobs: [job({ status: 'failed', failure_safe_message: 'The worker stopped responding.' })],
    };
    render(<LiveRecursivePanel runId="r1" events={[]} reconnectNonce={0} demoMode={false} />);
    expect(screen.getByRole('alert').textContent).toMatch(/stopped responding/i);
  });

  it('reports a load failure rather than showing stale figures as current', () => {
    treeState.data = { run_id: 'r1', jobs: [job()] };
    treeState.isError = true;
    treeState.error = { status: 500 };
    render(<LiveRecursivePanel runId="r1" events={[]} reconnectNonce={0} demoMode={false} />);
    expect(screen.getByText(/may be out of date/i)).toBeInTheDocument();
  });
});
