import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExecutionModeField } from './execution-mode-field';
import { defaultRecursiveConfig, type RecursiveAvailability } from '@/lib/recursive';
import type { RecursiveWorkerOut } from '@/api';

const NOW = Date.parse('2026-08-07T12:00:00Z');

function worker(over: Partial<RecursiveWorkerOut> = {}): RecursiveWorkerOut {
  return {
    id: 'w1',
    workspace_id: 'ws1',
    display_name: 'Lab workstation',
    status: 'online',
    enabled: true,
    token_prefix: 'vlsw_ab',
    adapter_version: '0.1.0',
    prime_agent_version: null,
    sandbox_mode: 'subprocess',
    capabilities: {} as RecursiveWorkerOut['capabilities'],
    model_catalog: [
      {
        model_key: 'qwen3:8b',
        display_name: 'Qwen3 8B',
        provider_kind: 'ollama',
        supports_recursive_agents: true,
      },
    ],
    last_seen_at: new Date(NOW - 5000).toISOString(),
    last_error_safe_message: null,
    enrolled_at: new Date(NOW - 90000).toISOString(),
    disabled_at: null,
    revoked_at: null,
    created_at: new Date(NOW - 90000).toISOString(),
    updated_at: new Date(NOW - 5000).toISOString(),
    ...over,
  };
}

const READY: RecursiveAvailability = {
  state: 'ready',
  workers: [{ worker: worker(), models: worker().model_catalog }],
};

const OFFLINE: RecursiveAvailability = {
  state: 'offline',
  headline: 'No worker is online',
  detail: 'The enrolled machine has not checked in recently.',
  workers: [worker()],
};

function setup(over: Partial<React.ComponentProps<typeof ExecutionModeField>> = {}) {
  const onModeChange = vi.fn();
  const onConfigChange = vi.fn();
  const props: React.ComponentProps<typeof ExecutionModeField> = {
    mode: 'standard',
    config: null,
    availability: READY,
    onModeChange,
    onConfigChange,
    idPrefix: 'p1',
    ...over,
  };
  const view = render(<ExecutionModeField {...props} />);
  return { ...view, onModeChange, onConfigChange, props };
}

describe('ExecutionModeField', () => {
  it('defaults a seat to standard execution', () => {
    setup();
    const select = screen.getByLabelText(/execution runtime/i) as HTMLSelectElement;
    expect(select.value).toBe('standard');
  });

  it('only changes the runtime when the researcher picks one', async () => {
    const { onModeChange } = setup();
    await userEvent.selectOptions(screen.getByLabelText(/execution runtime/i), 'recursive_rlm');
    expect(onModeChange).toHaveBeenCalledWith('recursive_rlm');
  });

  // The core safety property: losing the worker must not rewrite the choice.
  it('keeps a recursive seat on recursive when availability degrades', () => {
    const { onModeChange, onConfigChange } = setup({
      mode: 'recursive_rlm',
      config: defaultRecursiveConfig('w1', 'qwen3:8b'),
      availability: OFFLINE,
    });

    const select = screen.getByLabelText(/execution runtime/i) as HTMLSelectElement;
    expect(select.value).toBe('recursive_rlm');
    // Nothing may be rewritten behind the researcher's back.
    expect(onModeChange).not.toHaveBeenCalled();
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('explains the blocker without offering a silent standard fallback', () => {
    setup({
      mode: 'recursive_rlm',
      config: defaultRecursiveConfig('w1', 'qwen3:8b'),
      availability: OFFLINE,
    });

    expect(screen.getByText(/no worker is online/i)).toBeInTheDocument();
    expect(
      screen.getByText(/nothing will be run on a standard provider in its place/i),
    ).toBeInTheDocument();
  });

  it('keeps the recursive option selectable while it is already chosen', () => {
    setup({
      mode: 'recursive_rlm',
      config: defaultRecursiveConfig('w1', 'qwen3:8b'),
      availability: OFFLINE,
    });
    const option = screen.getByRole('option', { name: /recursive agent/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
  });

  it('disables the recursive option when it was never chosen and is unavailable', () => {
    setup({ availability: OFFLINE });
    const option = screen.getByRole('option', { name: /recursive agent/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('warns that a recursive seat runs on the researcher’s own machine', () => {
    setup({ mode: 'recursive_rlm', config: defaultRecursiveConfig('w1', 'qwen3:8b') });
    expect(screen.getByText(/runs on your machine \(beta\)/i)).toBeInTheDocument();
  });

  it('describes the limits as ceilings rather than predictions', async () => {
    setup({ mode: 'recursive_rlm', config: defaultRecursiveConfig('w1', 'qwen3:8b') });
    await userEvent.click(screen.getByRole('button', { name: /limits for this participant/i }));
    expect(screen.getByText(/ceilings, not targets/i)).toBeInTheDocument();
  });

  it('clamps an out-of-range limit instead of sending it to the server', async () => {
    const { onConfigChange } = setup({
      mode: 'recursive_rlm',
      config: defaultRecursiveConfig('w1', 'qwen3:8b'),
    });
    await userEvent.click(screen.getByRole('button', { name: /limits for this participant/i }));

    const depth = screen.getByLabelText(/^depth$/i);
    await userEvent.clear(depth);
    await userEvent.type(depth, '9');

    const last = onConfigChange.mock.calls.at(-1)?.[0];
    expect(last.max_depth).toBeLessThanOrEqual(2);
  });

  it('flags a model with no reported pricing rather than assuming it is free', () => {
    const unpriced = worker({
      model_catalog: [
        {
          model_key: 'local',
          display_name: 'Local',
          provider_kind: 'ollama',
          supports_recursive_agents: true,
        },
      ],
    });
    setup({
      mode: 'recursive_rlm',
      config: defaultRecursiveConfig('w1', 'local'),
      availability: { state: 'ready', workers: [{ worker: unpriced, models: unpriced.model_catalog }] },
    });
    expect(screen.getByRole('option', { name: /no pricing reported/i })).toBeInTheDocument();
  });

  it('never renders a host path, token or credential for the chosen worker', () => {
    const { container } = setup({
      mode: 'recursive_rlm',
      config: defaultRecursiveConfig('w1', 'qwen3:8b'),
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/vlsw_/);
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(text).not.toMatch(/api[_ -]?key|token|password/i);
  });
});
