import React from 'react';
import { Link, useLocation } from 'wouter';
import { Home, FolderGit2, Bot, FileText, Activity, Sun, Moon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { theme, setTheme } = useTheme();

  const nav = [
    { label: 'Dashboard', path: '/app', icon: Home },
    { label: 'Projects', path: '/app/projects', icon: FolderGit2 },
    { label: 'Agent Studio', path: '/app/agents', icon: Bot },
    { label: 'Templates', path: '/app/templates', icon: FileText },
    { label: 'Runs', path: '/app/runs', icon: Activity },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col md:flex-row vls-app-background">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-b md:border-r border-border/50 vls-glass flex flex-col z-10 relative">
        <div className="p-4 border-b border-border/50 flex items-center justify-between">
          <Link href="/app" className="flex items-center gap-2 font-display font-bold text-lg text-primary">
            <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center border border-primary/30">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            Virtual Lab
          </Link>
          <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="md:hidden">
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>
        
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {nav.map(item => {
            const isActive = location === item.path || (item.path !== '/app' && location.startsWith(item.path));
            return (
              <Link key={item.path} href={item.path} className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-border/50 flex flex-col gap-2">
          <Link href="/app/meetings/new" className="flex items-center justify-center gap-2 w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
            + New Meeting
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-x-hidden relative h-[100dvh] overflow-y-auto">
        {/* Topbar for desktop theme toggle */}
        <div className="hidden md:flex absolute top-4 right-4 z-20">
           <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="vls-glass rounded-full text-muted-foreground hover:text-foreground">
             {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
           </Button>
        </div>
        {children}
      </main>
    </div>
  );
}
