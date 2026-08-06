import React, { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useSession } from '@/api/session';
import { useTheme } from '@/components/theme-provider';
import {
  LayoutDashboard,
  FolderOpen,
  Users,
  LayoutTemplate,
  Library,
  Activity,
  Settings,
  Menu,
  X,
  Sun,
  Moon,
  LogOut,
  FlaskConical,
  Beaker,
  BookOpen
} from 'lucide-react';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { workspace } = useSession();
  const { theme, toggleTheme } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { href: '/app', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/app/projects', label: 'Projects', icon: FolderOpen },
    { href: '/app/agents', label: 'Agents', icon: Users },
    { href: '/app/templates', label: 'Templates', icon: LayoutTemplate },
    { href: '/app/evidence', label: 'Evidence', icon: Library },
    { href: '/app/runs', label: 'Runs', icon: Activity },
  ];

  const bottomNavItems = [
    { href: '/guide', label: 'Guide', icon: BookOpen },
    { href: '/app/settings/profile', label: 'Settings', icon: Settings },
  ];

  const NavContent = () => (
    <div className="flex flex-col h-full">
      <div className="p-6">
        <Link href="/app" className="flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
          <div className="h-8 w-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center border border-primary/30">
            <FlaskConical className="w-5 h-5" />
          </div>
          <span className="font-display font-bold text-lg tracking-tight">Virtual Lab Studio</span>
        </Link>
      </div>
      
      <div className="px-4 mb-4">
        <div className="vls-glass rounded-lg p-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Workspace</div>
          <div className="font-medium text-sm truncate">{workspace?.name ?? 'Workspace'}</div>
        </div>
      </div>

      <nav className="flex-1 px-4 space-y-1">
        {navItems.map((item) => {
          const isActive = location === item.href || (item.href !== '/app' && location.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                isActive 
                  ? 'bg-primary/10 text-primary' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
              }`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 space-y-1">
        {bottomNavItems.map((item) => {
          const isActive = location.startsWith(item.href.split('/profile')[0]);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                isActive 
                  ? 'bg-primary/10 text-primary' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
              }`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
        <button
          onClick={toggleTheme}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          Toggle Theme
        </button>
        <Link
          href="/"
          className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Exit Workspace
        </Link>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-[100dvh] w-full">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 flex-col border-r border-border/50 vls-glass m-4 rounded-xl overflow-hidden shrink-0 h-[calc(100dvh-2rem)] sticky top-4">
        <NavContent />
      </aside>

      {/* Mobile Nav */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-16 border-b border-border/50 vls-glass z-50 flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <FlaskConical className="w-6 h-6 text-primary" />
          <span className="font-display font-bold">Virtual Lab Studio</span>
        </div>
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="p-2 -mr-2 text-muted-foreground hover:text-foreground"
        >
          {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm mt-16 border-t border-border/50">
          <div className="vls-glass h-full w-full">
            <NavContent />
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 min-w-0 pt-16 lg:pt-0 lg:p-4 pb-4">
        <div className="h-full rounded-xl vls-glass overflow-hidden flex flex-col relative z-0">
          <div className="flex-1 overflow-auto bg-black/10 dark:bg-black/20 p-4 lg:p-8">
            <div className="max-w-6xl mx-auto h-full">
              {children}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
