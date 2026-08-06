import React from 'react';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider, useSession } from '@/api/session';
import { AppShell } from '@/components/app-shell';
import { Loader2 } from 'lucide-react';
import { Redirect } from 'wouter';
import NotFound from '@/pages/not-found';

import Landing from '@/pages/landing';
import Methodology from '@/pages/methodology';
import SignIn from '@/pages/sign-in';
import Dashboard from '@/pages/dashboard';
import Projects from '@/pages/projects';
import ProjectDetail from '@/pages/project-detail';
import Agents from '@/pages/agents';
import Templates from '@/pages/templates';
import Evidence from '@/pages/evidence';
import Runs from '@/pages/runs';
import Composer from '@/pages/composer';
import LiveRoom from '@/pages/live-room';
import RunDetail from '@/pages/run-detail';
import Settings from '@/pages/settings';
import ProjectCompare from '@/pages/project-compare';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AppRoutes() {
  const { isLoading, isAuthenticated } = useSession();

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" aria-label="Loading workspace" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to="/sign-in" />;
  }

  return (
    <AppShell>
      <Switch>
        <Route path="/app" component={Dashboard} />
        <Route path="/app/projects" component={Projects} />
        <Route path="/app/projects/new" component={ProjectDetail} />
        <Route path="/app/projects/:projectId" component={ProjectDetail} />
        <Route path="/app/projects/:projectId/:tab" component={ProjectDetail} />
        <Route path="/app/agents" component={Agents} />
        <Route path="/app/templates" component={Templates} />
        <Route path="/app/evidence" component={Evidence} />
        <Route path="/app/runs" component={Runs} />
        <Route path="/app/meetings/new" component={Composer} />
        <Route path="/app/runs/:runId/live" component={LiveRoom} />
        <Route path="/app/runs/:runId" component={RunDetail} />
        <Route path="/app/settings/:tab" component={Settings} />
        <Route path="/app/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/methodology" component={Methodology} />
      <Route path="/sign-in" component={SignIn} />
      <Route path="/app/*" component={AppRoutes} />
      <Route path="/app" component={AppRoutes} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ThemeProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <Router />
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

export default App;
