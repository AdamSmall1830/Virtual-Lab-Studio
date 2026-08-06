import React, { useEffect, useRef } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, useClerk } from '@clerk/react';
import {
  clerkPubKey,
  clerkProxyUrl,
  clerkAppearance,
  clerkLocalization,
  basePath,
  stripBase,
} from '@/lib/clerk';
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
import Guide from '@/pages/guide';
import SignIn from '@/pages/sign-in';
import SignUp from '@/pages/sign-up';
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
      <Route path="/guide" component={Guide} />
      {/* REQUIRED — the /*? optional wildcard matches both the bare URL and
          Clerk's OAuth sub-paths (/sign-in/sso-callback, /sign-in/factor-one). */}
      <Route path="/sign-in/*?" component={SignIn} />
      <Route path="/sign-up/*?" component={SignUp} />
      <Route path="/app/*" component={AppRoutes} />
      <Route path="/app" component={AppRoutes} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Keeps the webview up-to-date when the signed-in Clerk user changes by
// invalidating the QueryClient cache.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={clerkLocalization}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <SessionProvider>
          <ThemeProvider>
            <TooltipProvider>
              <Router />
              <Toaster />
            </TooltipProvider>
          </ThemeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
