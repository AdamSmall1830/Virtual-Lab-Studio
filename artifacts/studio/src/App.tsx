import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from 'next-themes';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import Home from '@/pages/Home';
import Methodology from '@/pages/Methodology';
import Dashboard from '@/pages/Dashboard';
import AgentStudio from '@/pages/agents/AgentStudio';
import ProjectList from '@/pages/projects/ProjectList';
import ProjectNew from '@/pages/projects/ProjectNew';
import ProjectDetail from '@/pages/projects/ProjectDetail';
import TemplateLibrary from '@/pages/templates/TemplateLibrary';
import RunList from '@/pages/runs/RunList';
import MeetingComposer from '@/pages/meetings/MeetingComposer';
import LiveMeetingRoom from '@/pages/runs/LiveMeetingRoom';
import RunDetail from '@/pages/runs/RunDetail';
import { AppShell } from '@/components/layout/AppShell';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } }
});

function NotFound() {
  return <div className="p-8 text-center text-muted-foreground h-full flex items-center justify-center">Page not found.</div>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/methodology" component={Methodology} />
      
      <Route path="/app">
        <AppShell><Dashboard /></AppShell>
      </Route>
      <Route path="/app/agents">
        <AppShell><AgentStudio /></AppShell>
      </Route>
      <Route path="/app/projects">
        <AppShell><ProjectList /></AppShell>
      </Route>
      <Route path="/app/projects/new">
        <AppShell><ProjectNew /></AppShell>
      </Route>
      <Route path="/app/projects/:projectId">
        <AppShell><ProjectDetail /></AppShell>
      </Route>
      <Route path="/app/templates">
        <AppShell><TemplateLibrary /></AppShell>
      </Route>
      <Route path="/app/runs">
        <AppShell><RunList /></AppShell>
      </Route>
      <Route path="/app/meetings/new">
        <AppShell><MeetingComposer /></AppShell>
      </Route>
      <Route path="/app/runs/:runId/live">
        <AppShell><LiveMeetingRoom /></AppShell>
      </Route>
      <Route path="/app/runs/:runId">
        <AppShell><RunDetail /></AppShell>
      </Route>
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
