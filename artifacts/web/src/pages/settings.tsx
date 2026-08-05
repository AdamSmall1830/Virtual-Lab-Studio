import React from 'react';
import { useRoute, Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { resetWorkspace } from '@/demo/store';
import { ShieldAlert, RefreshCw, User, Settings as SettingsIcon, Server, FileLock2, Database } from 'lucide-react';

export default function Settings() {
  const [, params] = useRoute('/app/settings/:tab?');
  const tab = params?.tab || 'profile';
  const workspace = useWorkspace();

  const handleReset = () => {
    if (confirm('Are you sure you want to reset the entire demo workspace to its initial seeded state? All custom projects, runs, and agents will be lost permanently.')) {
      resetWorkspace();
      window.location.href = '/app';
    }
  };

  const tabs = [
    { id: 'profile', label: 'Profile & Preferences', icon: User },
    { id: 'workspace', label: 'Workspace Details', icon: SettingsIcon },
    { id: 'providers', label: 'Providers & Models', icon: Server },
    { id: 'governance', label: 'Governance & Rules', icon: FileLock2 },
    { id: 'audit', label: 'Audit Log', icon: Database },
  ];

  return (
    <div className="max-w-5xl mx-auto h-full flex flex-col pb-12 animate-in fade-in duration-300">
      <header className="mb-8">
        <h1 className="text-3xl font-display font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure your Virtual Lab Studio environment.</p>
      </header>

      <div className="flex flex-col md:flex-row gap-8">
        <aside className="w-full md:w-64 shrink-0">
          <nav className="flex flex-col space-y-1">
            {tabs.map(t => (
              <Link 
                key={t.id}
                href={`/app/settings/${t.id}`}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  tab === t.id 
                    ? 'bg-primary/10 text-primary' 
                    : 'text-muted-foreground hover:bg-background hover:text-foreground'
                }`}
              >
                <t.icon className="w-4 h-4" />
                {t.label}
              </Link>
            ))}
          </nav>
        </aside>

        <main className="flex-1 space-y-8">
          {tab === 'profile' && (
            <div className="vls-reading-surface rounded-xl p-6 border space-y-6">
              <h2 className="text-lg font-display font-semibold mb-4 border-b border-border pb-2">Profile & Preferences</h2>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Theme</div>
                    <div className="text-sm text-muted-foreground">Dark or light mode. Dark is standard for the Studio.</div>
                  </div>
                  <div className="bg-background px-3 py-1.5 rounded-lg text-sm border capitalize">
                    {workspace.theme}
                  </div>
                </div>
                
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Reduced Motion</div>
                    <div className="text-sm text-muted-foreground">Respects your OS preferences automatically via CSS.</div>
                  </div>
                  <div className="bg-background px-3 py-1.5 rounded-lg text-sm border text-muted-foreground">
                    Auto
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'providers' && (
            <div className="space-y-6">
              <div className="bg-primary/10 border border-primary/20 p-4 rounded-xl flex items-start gap-4">
                <Server className="w-6 h-6 text-primary shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-sm text-primary mb-1">Model Providers</h3>
                  <p className="text-xs text-muted-foreground">Virtual Lab Studio supports OpenAI and OpenAI-compatible endpoints (vLLM, local models). Provider configuration is handled by the backend API.</p>
                </div>
              </div>

              <div className="vls-reading-surface rounded-xl p-6 border space-y-6">
                <div className="flex items-center justify-between p-4 bg-background border rounded-lg border-primary/30">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold font-mono">D</div>
                    <div>
                      <div className="font-semibold flex items-center gap-2">Deterministic Demo Provider <span className="bg-primary/10 text-primary text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider">Active</span></div>
                      <div className="text-sm text-muted-foreground">Simulates a full multi-agent meeting deterministically. No cost.</div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between p-4 bg-background border rounded-lg opacity-60">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-muted text-muted-foreground flex items-center justify-center font-bold">O</div>
                    <div>
                      <div className="font-semibold">OpenAI API</div>
                      <div className="text-sm text-muted-foreground">Requires backend connection in production build.</div>
                    </div>
                  </div>
                  <button disabled className="px-3 py-1.5 rounded border text-sm font-medium">Configure</button>
                </div>
              </div>
            </div>
          )}

          <div className="mt-12 pt-8 border-t border-border">
            <h3 className="text-lg font-display font-semibold text-destructive mb-2 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5" /> Danger Zone
            </h3>
            <div className="vls-glass border-destructive/30 p-6 rounded-xl flex items-center justify-between">
              <div>
                <div className="font-semibold text-foreground">Reset Demo Workspace</div>
                <div className="text-sm text-muted-foreground mt-1">Erase all runs, projects, and custom agents, restoring the seeded defaults.</div>
              </div>
              <button 
                onClick={handleReset}
                className="bg-destructive text-destructive-foreground px-4 py-2 rounded-lg font-medium text-sm hover:bg-destructive/90 transition-colors flex items-center gap-2 shrink-0"
              >
                <RefreshCw className="w-4 h-4" /> Factory Reset
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
