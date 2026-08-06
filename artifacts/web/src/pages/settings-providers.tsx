// Providers & Models settings tab: add, edit, and test OpenAI-compatible
// model providers. API keys are write-only — sent once on save, encrypted
// server-side, and never returned to the browser.
import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useProviders,
  getProvidersQueryKey,
  useCreateProvider,
  useUpdateProvider,
  useTestProvider,
  useProviderEnvironment,
} from '@/api';
import type { ProviderConfigOut, ProviderModelIn } from '@/api';
import {
  Server, Loader2, Plus, X, KeyRound, Sparkles, CheckCircle2, XCircle, FlaskConical,
} from 'lucide-react';

type ModelRow = {
  model_key: string;
  display_name: string;
  input_per_million: string;
  output_per_million: string;
};

const EMPTY_MODEL: ModelRow = { model_key: '', display_name: '', input_per_million: '', output_per_million: '' };

function toModelIn(rows: ModelRow[]): ProviderModelIn[] {
  return rows
    .filter((r) => r.model_key.trim())
    .map((r) => ({
      model_key: r.model_key.trim(),
      display_name: r.display_name.trim() || r.model_key.trim(),
      input_per_million: r.input_per_million.trim() ? Number(r.input_per_million) : null,
      output_per_million: r.output_per_million.trim() ? Number(r.output_per_million) : null,
      is_enabled: true,
    }));
}

function errText(err: unknown): string {
  const anyErr = err as { detail?: unknown } | undefined;
  const d = anyErr && (anyErr as Record<string, unknown>).detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg);
  const t = (anyErr as Record<string, unknown> | undefined)?.title;
  if (typeof t === 'string') return t;
  return 'Request failed. Check the values and try again.';
}

function ModelRowsEditor({ rows, setRows }: { rows: ModelRow[]; setRows: (r: ModelRow[]) => void }) {
  const update = (i: number, patch: Partial<ModelRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_1fr_90px_90px_28px] gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Model key</span><span>Display name</span><span>$/1M in</span><span>$/1M out</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_90px_90px_28px] gap-2">
          <input value={r.model_key} onChange={(e) => update(i, { model_key: e.target.value })}
            placeholder="gpt-5-mini" className="vls-input font-mono text-xs" data-testid={`input-model-key-${i}`} />
          <input value={r.display_name} onChange={(e) => update(i, { display_name: e.target.value })}
            placeholder="GPT-5 Mini" className="vls-input text-xs" />
          <input value={r.input_per_million} onChange={(e) => update(i, { input_per_million: e.target.value })}
            placeholder="0.25" inputMode="decimal" className="vls-input text-xs" />
          <input value={r.output_per_million} onChange={(e) => update(i, { output_per_million: e.target.value })}
            placeholder="2.00" inputMode="decimal" className="vls-input text-xs" />
          <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}
            className="text-muted-foreground hover:text-destructive" aria-label="Remove model">
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { ...EMPTY_MODEL }])}
        className="text-xs text-primary flex items-center gap-1 hover:underline" data-testid="button-add-model-row">
        <Plus className="w-3 h-3" /> Add model
      </button>
    </div>
  );
}

function AddProviderForm({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const envQuery = useProviderEnvironment();
  const replitAvailable = Boolean(envQuery.data?.replit_ai_available);
  const create = useCreateProvider();

  const [source, setSource] = React.useState<'openai' | 'compatible' | 'replit_ai'>('openai');
  const [name, setName] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [rows, setRows] = React.useState<ModelRow[]>([{ ...EMPTY_MODEL }]);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const models = toModelIn(rows);
    if (models.length === 0) { setError('Add at least one model key.'); return; }
    try {
      await create.mutateAsync({
        workspaceId,
        data: {
          name: name.trim() || (source === 'replit_ai' ? 'Replit AI' : source === 'openai' ? 'OpenAI' : 'Custom endpoint'),
          provider_type: source === 'compatible' ? 'openai_compatible' : 'openai',
          base_url: source === 'compatible' ? baseUrl.trim() : null,
          api_key: source === 'replit_ai' ? null : apiKey,
          credential_source: source === 'replit_ai' ? 'replit_ai' : 'api_key',
          models,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getProvidersQueryKey(workspaceId) });
      onDone();
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <form onSubmit={submit} className="bg-background border rounded-lg p-4 space-y-4" data-testid="form-add-provider">
      <div className="flex gap-2 flex-wrap">
        {([
          ['openai', 'OpenAI', KeyRound],
          ['compatible', 'OpenAI-compatible', Server],
          ['replit_ai', 'Replit AI (no key)', Sparkles],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => setSource(id)}
            disabled={id === 'replit_ai' && !replitAvailable}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
              source === id ? 'border-primary text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'
            } ${id === 'replit_ai' && !replitAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
            data-testid={`button-source-${id}`}>
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>
      {source === 'replit_ai' && (
        <p className="text-xs text-muted-foreground">
          Uses the workspace's Replit AI integration — no API key needed. Usage is billed to the Replit account.
        </p>
      )}
      {source === 'replit_ai' && !replitAvailable && (
        <p className="text-xs text-amber-500">Replit AI is not configured in this environment.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenAI (lab account)"
            className="vls-input w-full" data-testid="input-provider-name" />
        </label>
        {source === 'compatible' && (
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">Base URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required
              placeholder="https://api.example.com/v1" className="vls-input w-full font-mono"
              data-testid="input-provider-base-url" />
          </label>
        )}
        {source !== 'replit_ai' && (
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">API key (stored encrypted, never shown again)</span>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} required type="password"
              placeholder="sk-…" className="vls-input w-full font-mono" autoComplete="off"
              data-testid="input-provider-api-key" />
          </label>
        )}
      </div>
      <div>
        <div className="text-xs text-muted-foreground mb-2">Models (prices per 1M tokens are optional but enable cost estimates)</div>
        <ModelRowsEditor rows={rows} setRows={setRows} />
      </div>
      {error && <p className="text-xs text-destructive" data-testid="text-add-provider-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={create.isPending}
          className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          data-testid="button-save-provider">
          {create.isPending ? 'Saving…' : 'Save provider'}
        </button>
        <button type="button" onClick={onDone} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
      </div>
    </form>
  );
}

function ProviderCard({ p, workspaceId }: { p: ProviderConfigOut; workspaceId: string }) {
  const queryClient = useQueryClient();
  const update = useUpdateProvider();
  const test = useTestProvider();
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(p.name);
  const [apiKey, setApiKey] = React.useState('');
  const [rows, setRows] = React.useState<ModelRow[]>(
    (p.models ?? []).map((m) => ({
      model_key: m.model_key,
      display_name: m.display_name,
      input_per_million: m.input_per_million != null ? String(m.input_per_million) : '',
      output_per_million: m.output_per_million != null ? String(m.output_per_million) : '',
    })),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<{ status: string; message: string } | null>(null);
  const isDemo = p.provider_type === 'demo';
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getProvidersQueryKey(workspaceId) });

  const saveEdit = async () => {
    setError(null);
    try {
      await update.mutateAsync({
        providerId: p.id,
        data: {
          name: name.trim() || p.name,
          api_key: apiKey.trim() ? apiKey : null,
          models: toModelIn(rows),
        },
      });
      await invalidate();
      setApiKey('');
      setEditing(false);
    } catch (err) { setError(errText(err)); }
  };

  const runTest = async () => {
    setTestResult(null);
    try {
      const r = await test.mutateAsync({ providerId: p.id });
      setTestResult({ status: r.status, message: r.message });
      await invalidate();
    } catch (err) { setTestResult({ status: 'failed', message: errText(err) }); }
  };

  return (
    <div className="p-4 bg-background border rounded-lg space-y-3" data-testid={`card-provider-${p.id}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold font-mono uppercase shrink-0">
            {p.name.charAt(0)}
          </div>
          <div className="min-w-0">
            <div className="font-semibold flex items-center gap-2 flex-wrap">
              {p.name}
              <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider ${
                isDemo ? 'bg-amber-500/10 text-amber-500' : 'bg-primary/10 text-primary'
              }`}>
                {isDemo ? 'Simulation' : 'Real model'}
              </span>
              {p.credential_source === 'replit_ai' && (
                <span className="bg-primary/10 text-primary text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider">Replit AI</span>
              )}
              {!p.is_enabled && (
                <span className="bg-muted text-muted-foreground text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider">Disabled</span>
              )}
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {p.provider_type}
              {p.base_url && ` · ${p.base_url}`}
              {p.models && p.models.length > 0 && ` · ${p.models.length} model${p.models.length > 1 ? 's' : ''}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={runTest} disabled={test.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border hover:bg-primary/5 disabled:opacity-50"
            data-testid={`button-test-provider-${p.id}`}>
            {test.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            Test
          </button>
          {!isDemo && (
            <button onClick={() => setEditing((v) => !v)}
              className="px-3 py-1.5 rounded-lg text-xs border hover:bg-primary/5"
              data-testid={`button-edit-provider-${p.id}`}>
              {editing ? 'Close' : 'Edit'}
            </button>
          )}
          <button
            onClick={async () => { await update.mutateAsync({ providerId: p.id, data: { is_enabled: !p.is_enabled } }); await invalidate(); }}
            className="px-3 py-1.5 rounded-lg text-xs border hover:bg-primary/5"
            data-testid={`button-toggle-provider-${p.id}`}>
            {p.is_enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>

      {(testResult || p.last_test_status) && (
        <div className={`flex items-start gap-2 text-xs ${
          (testResult?.status ?? p.last_test_status) === 'ok' ? 'text-emerald-500' : 'text-destructive'
        }`} data-testid={`text-test-status-${p.id}`}>
          {(testResult?.status ?? p.last_test_status) === 'ok'
            ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span>{testResult?.message ?? p.last_test_safe_message}</span>
        </div>
      )}

      {editing && !isDemo && (
        <div className="border-t pt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className="vls-input w-full" />
            </label>
            {p.credential_source !== 'replit_ai' && (
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">Replace API key (leave blank to keep current)</span>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password"
                  placeholder="sk-…" className="vls-input w-full font-mono" autoComplete="off" />
              </label>
            )}
          </div>
          <ModelRowsEditor rows={rows} setRows={setRows} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button onClick={saveEdit} disabled={update.isPending}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
            data-testid={`button-save-edit-${p.id}`}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function ProvidersTab({ workspaceId }: { workspaceId: string }) {
  const providersQuery = useProviders(workspaceId, {
    query: { queryKey: getProvidersQueryKey(workspaceId), enabled: Boolean(workspaceId) },
  });
  const [adding, setAdding] = React.useState(false);

  return (
    <div className="space-y-6">
      <div className="bg-primary/10 border border-primary/20 p-4 rounded-xl flex items-start gap-4">
        <Server className="w-6 h-6 text-primary shrink-0 mt-0.5" />
        <div>
          <h3 className="font-semibold text-sm text-primary mb-1">Model Providers</h3>
          <p className="text-xs text-muted-foreground">
            Run meetings on the deterministic Demo Provider or on real OpenAI-compatible models.
            API keys are encrypted server-side and never sent back to the browser. Runs on real
            providers are truthfully labeled as model-generated (not simulations).
          </p>
        </div>
      </div>

      <div className="vls-reading-surface rounded-xl p-6 border space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-display font-semibold">Configured providers</h2>
          {!adding && (
            <button onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-primary text-primary-foreground"
              data-testid="button-add-provider">
              <Plus className="w-4 h-4" /> Add provider
            </button>
          )}
        </div>
        {adding && <AddProviderForm workspaceId={workspaceId} onDone={() => setAdding(false)} />}
        {providersQuery.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading providers…
          </div>
        )}
        {providersQuery.isError && <p className="text-sm text-destructive">Could not load providers.</p>}
        {providersQuery.data?.map((p) => <ProviderCard key={p.id} p={p} workspaceId={workspaceId} />)}
        {providersQuery.data && providersQuery.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No providers configured for this workspace.</p>
        )}
      </div>
    </div>
  );
}
