import { describe, expect, it } from 'vitest';
import {
  WORKER_OFFLINE_AFTER_SECONDS,
  buildNodeTree,
  clampBound,
  defaultRecursiveConfig,
  describeRecursiveEvent,
  formatUsd,
  isRecursiveEvent,
  jobStatusPresentation,
  nodeStatusPresentation,
  recursiveAvailability,
  recursiveConfigProblems,
  recursiveModels,
  summariseNodes,
  workerIsOnline,
  workerStatusPresentation,
  type EligibleWorker,
} from './recursive';
import type { RecursiveAgentNodeOut, RecursiveWorkerOut, RunEventOut } from '@/api';

const NOW = Date.parse('2026-08-07T12:00:00Z');
const secondsAgo = (n: number) => new Date(NOW - n * 1000).toISOString();

function worker(over: Partial<RecursiveWorkerOut> = {}): RecursiveWorkerOut {
  return {
    id: 'w1',
    workspace_id: 'ws1',
    display_name: 'Lab box',
    status: 'online',
    enabled: true,
    token_prefix: 'vlsw_ab',
    adapter_version: '0.1.0',
    prime_agent_version: null,
    sandbox_mode: 'subprocess',
    capabilities: {} as RecursiveWorkerOut['capabilities'],
    model_catalog: [
      { model_key: 'qwen3:8b', display_name: 'Qwen3 8B', supports_recursive_agents: true },
    ],
    last_seen_at: secondsAgo(5),
    last_error_safe_message: null,
    enrolled_at: secondsAgo(9000),
    disabled_at: null,
    revoked_at: null,
    created_at: secondsAgo(9000),
    updated_at: secondsAgo(5),
    ...over,
  };
}

function node(over: Partial<RecursiveAgentNodeOut> = {}): RecursiveAgentNodeOut {
  return {
    id: 'n1',
    job_id: 'j1',
    external_node_id: 'root',
    parent_external_node_id: null,
    display_name: 'Coordinator',
    status: 'completed',
    model_key: 'qwen3:8b',
    task_summary: null,
    result_summary: null,
    cited_evidence_keys: [],
    tool_labels: [],
    model_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    started_at: null,
    completed_at: null,
    failure_safe_message: null,
    ...over,
  };
}

describe('worker liveness', () => {
  // The backend never sweeps a dead worker back to 'offline', so a crashed
  // machine keeps status='online' forever. Freshness is the only honest signal.
  it('treats a stale check-in as offline even when status says online', () => {
    const stale = worker({
      status: 'online',
      last_seen_at: secondsAgo(WORKER_OFFLINE_AFTER_SECONDS + 1),
    });
    expect(workerIsOnline(stale, NOW)).toBe(false);
  });

  it('treats a recent check-in as online', () => {
    expect(workerIsOnline(worker({ last_seen_at: secondsAgo(10) }), NOW)).toBe(true);
  });

  it('never treats a disabled or revoked worker as online', () => {
    expect(workerIsOnline(worker({ enabled: false }), NOW)).toBe(false);
    expect(workerIsOnline(worker({ revoked_at: secondsAgo(1) }), NOW)).toBe(false);
    expect(workerIsOnline(worker({ status: 'revoked' }), NOW)).toBe(false);
  });

  it('has never seen a worker that has not checked in', () => {
    expect(workerIsOnline(worker({ last_seen_at: null }), NOW)).toBe(false);
  });
});

describe('recursiveAvailability', () => {
  it('reports unsupported on 404 — the runtime is not in this deployment', () => {
    const a = recursiveAvailability({
      isLoading: false,
      error: { status: 404 },
      workers: [],
      now: NOW,
    });
    expect(a.state).toBe('unsupported');
  });

  it('separates "not permitted" from "not deployed"', () => {
    const a = recursiveAvailability({
      isLoading: false,
      error: { status: 403 },
      workers: [],
      now: NOW,
    });
    expect(a.state).toBe('forbidden');
  });

  it('distinguishes no workers, stale workers and no compatible model', () => {
    expect(recursiveAvailability({ isLoading: false, workers: [], now: NOW }).state).toBe(
      'no_workers',
    );

    expect(
      recursiveAvailability({
        isLoading: false,
        workers: [worker({ last_seen_at: secondsAgo(600) })],
        now: NOW,
      }).state,
    ).toBe('offline');

    expect(
      recursiveAvailability({
        isLoading: false,
        workers: [
          worker({
            model_catalog: [
              { model_key: 'llama', display_name: 'Llama', supports_recursive_agents: false },
            ],
          }),
        ],
        now: NOW,
      }).state,
    ).toBe('no_model');
  });

  it('is ready when an online worker advertises a recursive-capable model', () => {
    const a = recursiveAvailability({ isLoading: false, workers: [worker()], now: NOW });
    expect(a.state).toBe('ready');
    if (a.state === 'ready') {
      expect(a.workers).toHaveLength(1);
      expect(a.workers[0].models[0].model_key).toBe('qwen3:8b');
    }
  });

  it('only offers models the worker marks as recursive-capable', () => {
    const w = worker({
      model_catalog: [
        { model_key: 'a', display_name: 'A', supports_recursive_agents: true },
        { model_key: 'b', display_name: 'B', supports_recursive_agents: false },
      ],
    });
    expect(recursiveModels(w)).toHaveLength(1);
    expect(recursiveModels(w)[0].model_key).toBe('a');
  });
});

describe('recursiveConfigProblems', () => {
  const w = worker();
  const eligible: EligibleWorker[] = [{ worker: w, models: recursiveModels(w) }];

  it('reports an unselected worker and model rather than picking one', () => {
    const problems = recursiveConfigProblems(defaultRecursiveConfig(), eligible);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/worker/i);
  });

  it('accepts a fully selected configuration', () => {
    const config = defaultRecursiveConfig('w1', 'qwen3:8b');
    expect(recursiveConfigProblems(config, eligible)).toEqual([]);
  });

  it('rejects a model the chosen worker does not advertise', () => {
    const config = defaultRecursiveConfig('w1', 'not-a-real-model');
    expect(recursiveConfigProblems(config, eligible).join(' ')).toMatch(/model/i);
  });

  // A half-configured recursive seat must block launch, never quietly demote
  // itself to a standard provider.
  it('never suggests falling back to a standard provider', () => {
    const all = [
      ...recursiveConfigProblems(defaultRecursiveConfig(), []),
      ...recursiveConfigProblems(defaultRecursiveConfig('w1', 'nope'), eligible),
    ].join(' ');
    expect(all).not.toMatch(/standard|fall ?back|instead/i);
  });
});

describe('clampBound', () => {
  it('clamps to the schema ceiling rather than accepting a silly value', () => {
    expect(clampBound('max_depth', 99)).toBe(2);
    expect(clampBound('max_children', 0)).toBe(1);
    expect(clampBound('max_runtime_seconds', 10)).toBe(60);
  });

  it('falls back to the default for a non-numeric entry', () => {
    expect(clampBound('max_children', Number.NaN)).toBe(defaultRecursiveConfig().max_children);
  });
});

describe('status presentation', () => {
  // Colour alone must never carry meaning, so every state needs a word.
  const nodeStates = ['queued', 'running', 'completed', 'failed', 'cancelled'];
  const jobStates = [
    'queued',
    'leased',
    'running',
    'cancellation_requested',
    'completed',
    'failed',
    'cancelled',
  ];

  it('always gives a node status a text label', () => {
    for (const s of nodeStates) {
      expect(nodeStatusPresentation(s).label.trim().length).toBeGreaterThan(0);
    }
  });

  it('always gives a job status a text label', () => {
    for (const s of jobStates) {
      expect(jobStatusPresentation(s).label.trim().length).toBeGreaterThan(0);
    }
  });

  it('labels an unknown status instead of rendering an empty chip', () => {
    expect(jobStatusPresentation('something_new').label.trim().length).toBeGreaterThan(0);
  });

  it('does not call a stale worker online, whatever its status column says', () => {
    const stale = worker({ status: 'online', last_seen_at: secondsAgo(600) });
    const label = workerStatusPresentation(stale, NOW).label;
    expect(label).toMatch(/not responding/i);
    expect(label).not.toMatch(/^online$/i);
  });

  it('reports a worker that has never checked in as such', () => {
    expect(workerStatusPresentation(worker({ last_seen_at: null }), NOW).label).toMatch(
      /never checked in/i,
    );
  });
});

describe('buildNodeTree', () => {
  it('nests children under their parents', () => {
    const tree = buildNodeTree([
      node({ id: 'a', external_node_id: 'a' }),
      node({ id: 'b', external_node_id: 'b', parent_external_node_id: 'a' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].node.external_node_id).toBe('b');
    expect(tree[0].children[0].depth).toBe(1);
  });

  it('surfaces an orphan at the root instead of dropping it', () => {
    const tree = buildNodeTree([
      node({ id: 'b', external_node_id: 'b', parent_external_node_id: 'missing' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].node.external_node_id).toBe('b');
  });

  it('does not hang or lose nodes on a parent cycle', () => {
    const tree = buildNodeTree([
      node({ id: 'a', external_node_id: 'a', parent_external_node_id: 'b' }),
      node({ id: 'b', external_node_id: 'b', parent_external_node_id: 'a' }),
    ]);
    const seen: string[] = [];
    const walk = (items: ReturnType<typeof buildNodeTree>) => {
      for (const i of items) {
        seen.push(i.node.external_node_id);
        walk(i.children);
      }
    };
    walk(tree);
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('ignores a duplicate node id rather than rendering it twice', () => {
    const tree = buildNodeTree([
      node({ id: 'a', external_node_id: 'a' }),
      node({ id: 'a-again', external_node_id: 'a' }),
    ]);
    expect(tree).toHaveLength(1);
  });
});

describe('summariseNodes', () => {
  it('counts each state separately and reports the deepest level reached', () => {
    const totals = summariseNodes([
      node({ id: '1', external_node_id: '1', status: 'completed' }),
      node({ id: '2', external_node_id: '2', parent_external_node_id: '1', status: 'failed' }),
      node({ id: '3', external_node_id: '3', parent_external_node_id: '2', status: 'running' }),
    ]);
    expect(totals.nodeCount).toBe(3);
    expect(totals.completed).toBe(1);
    expect(totals.failed).toBe(1);
    expect(totals.running).toBe(1);
    expect(totals.maxDepthSeen).toBe(2);
  });
});

describe('describeRecursiveEvent', () => {
  const ev = (event_type: string, payload: Record<string, unknown>): RunEventOut =>
    ({
      id: 'e',
      run_id: 'r',
      run_sequence: 1,
      event_type,
      payload,
      created_at: new Date(NOW).toISOString(),
    }) as unknown as RunEventOut;

  it('recognises the recursive event families', () => {
    expect(isRecursiveEvent('recursive.agent.started')).toBe(true);
    expect(isRecursiveEvent('recursive.job.completed')).toBe(true);
    expect(isRecursiveEvent('turn.completed')).toBe(false);
  });

  // The backend rebuilds worker payloads from a strict allow-list. This asserts
  // the reader does the same, so a future backend leak cannot reach the screen.
  it('reads only allow-listed fields, so a leaked payload cannot be rendered', () => {
    const described = describeRecursiveEvent(
      ev('recursive.agent.started', {
        node: { external_node_id: 'n2', display_name: 'Scout' },
        task_summary: 'Check the literature',
        api_key: 'sk-secret-value',
        host_path: 'C:/Users/adam/models',
        reasoning: 'internal chain of thought',
      }),
    );
    expect(described).not.toBeNull();
    const rendered = JSON.stringify(described);
    expect(rendered).toContain('Scout');
    expect(rendered).toContain('Check the literature');
    expect(rendered).not.toContain('sk-secret-value');
    expect(rendered).not.toContain('C:/Users');
    expect(rendered).not.toContain('chain of thought');
  });

  it('renders the safe failure message and nothing else from a failure', () => {
    const described = describeRecursiveEvent(
      ev('recursive.agent.failed', {
        message: 'The model stopped responding.',
        failure_detail: 'Traceback: /home/adam/rlm/main.py line 42',
      }),
    );
    const rendered = JSON.stringify(described);
    expect(rendered).toContain('stopped responding');
    expect(rendered).not.toContain('Traceback');
    expect(described?.tone).toBe('bad');
  });

  it('ignores an event that is not recursive', () => {
    expect(describeRecursiveEvent(ev('turn.completed', {}))).toBeNull();
  });
});

describe('formatUsd', () => {
  it('shows an unknown price as a dash, never as zero', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(null)).not.toBe('$0.00');
  });

  it('keeps sub-cent figures visible instead of rounding them away', () => {
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
