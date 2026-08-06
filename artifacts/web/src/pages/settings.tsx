import React from 'react';
import { useRoute, Link } from 'wouter';
import { useSession } from '@/api/session';
import { useTheme } from '@/components/theme-provider';
import ProvidersTab from './settings-providers';
import { User, Settings as SettingsIcon, Server, FileLock2, LogOut } from 'lucide-react';
import { useLocation } from 'wouter';

export default function Settings() {
  const [, params] = useRoute('/app/settings/:tab?');
  const tab = params?.tab || 'profile';
  const { user, workspace, workspaceId, signOut } = useSession();
  const { theme, toggleTheme } = useTheme();
  const [, setLocation] = useLocation();

  const tabs = [
    { id: 'profile', label: 'Profile & Preferences', icon: User },
    { id: 'workspace', label: 'Workspace Details', icon: SettingsIcon },
    { id: 'providers', label: 'Providers & Models', icon: Server },
    { id: 'governance', label: 'Governance & Rules', icon: FileLock2 },
  ];

  const handleSignOut = async () => {
    await signOut();
    setLocation('/sign-in');
  };

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
                    <div className="font-medium">Signed in as</div>
                    <div className="text-sm text-muted-foreground">{user?.email}</div>
                  </div>
                  <button
                    onClick={handleSignOut}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border hover:bg-background transition-colors"
                  >
                    <LogOut className="w-4 h-4" /> Sign out
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">Theme</div>
                    <div className="text-sm text-muted-foreground">Dark or light mode. Dark is standard for the Studio.</div>
                  </div>
                  <button
                    onClick={toggleTheme}
                    className="bg-background px-3 py-1.5 rounded-lg text-sm border capitalize hover:bg-primary/5 transition-colors"
                  >
                    {theme}
                  </button>
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

          {tab === 'workspace' && (
            <div className="vls-reading-surface rounded-xl p-6 border space-y-4">
              <h2 className="text-lg font-display font-semibold mb-4 border-b border-border pb-2">Workspace Details</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Name</div>
                  <div className="font-medium">{workspace?.name ?? '—'}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Slug</div>
                  <div className="font-mono text-sm">{workspace?.slug ?? '—'}</div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                All projects, agents, templates, evidence, and runs are stored permanently on the
                server, scoped to this workspace.
              </p>
            </div>
          )}

          {tab === 'providers' && workspaceId && <ProvidersTab workspaceId={workspaceId} />}

          {tab === 'governance' && (
            <div className="vls-reading-surface rounded-xl p-6 border space-y-4">
              <h2 className="text-lg font-display font-semibold mb-4 border-b border-border pb-2">Governance & Rules</h2>
              <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-2">
                <li>AI meeting participants are model personas, never presented as human experts.</li>
                <li>Runs reference frozen meeting definitions; completed transcripts are immutable.</li>
                <li>Every provider and tool call is recorded with usage and provenance.</li>
                <li>Generated conclusions are decision support, not validated results.</li>
              </ul>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
