// Session + workspace context backed by the real API.
//
// Identity comes from Clerk (managed sign-in). After Clerk sign-in, the
// short-lived Clerk session token is exchanged once at
// POST /api/v1/auth/clerk-login, which verifies it server-side and sets the
// app's own signed session cookie. All subsequent requests use that cookie.
// In development the backend's dev-login remains available as a fallback.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/react';
import {
  useMe,
  getMeQueryKey,
  useDevLogin,
  useLogout,
  apiBase,
  type MeOut,
  type UserOut,
  type WorkspaceOut,
} from './index';

interface SessionContextValue {
  /** Undefined while loading. */
  me: MeOut | null | undefined;
  user: UserOut | null;
  /** The active workspace (first membership). */
  workspace: WorkspaceOut | null;
  workspaceId: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (email: string, displayName?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const clerk = useAuth();
  const meQuery = useMe({
    query: {
      queryKey: getMeQueryKey(),
      retry: false,
      staleTime: 5 * 60 * 1000,
      // 401 is an expected signed-out state, not an error worth surfacing.
      throwOnError: false,
    },
  });
  const devLogin = useDevLogin();
  const logout = useLogout();

  const me = meQuery.isError ? null : meQuery.data;

  // Bridge: Clerk says signed in but the backend session is missing/expired —
  // exchange the Clerk token for the app session cookie exactly once per gap.
  const [isBridging, setIsBridging] = useState(false);
  const bridgeAttempted = useRef(false);
  const needsBridge = Boolean(clerk.isLoaded && clerk.isSignedIn && meQuery.isError);

  useEffect(() => {
    if (!needsBridge || bridgeAttempted.current) return;
    bridgeAttempted.current = true;
    setIsBridging(true);
    (async () => {
      try {
        const token = await clerk.getToken();
        if (!token) return;
        const res = await fetch(`${apiBase()}/v1/auth/clerk-login`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'include',
        });
        if (res.ok) {
          await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
        }
      } finally {
        setIsBridging(false);
      }
    })();
  }, [needsBridge, clerk, queryClient]);

  // Allow a fresh bridge attempt after the Clerk user changes.
  useEffect(() => {
    if (!clerk.isSignedIn) bridgeAttempted.current = false;
  }, [clerk.isSignedIn]);

  const value = useMemo<SessionContextValue>(() => {
    const workspace = me?.workspaces?.[0] ?? null;
    return {
      me,
      user: me?.user ?? null,
      workspace,
      workspaceId: workspace?.id ?? null,
      isLoading:
        meQuery.isLoading || !clerk.isLoaded || isBridging || (needsBridge && !bridgeAttempted.current),
      isAuthenticated: Boolean(me?.user),
      signIn: async (email: string, displayName?: string) => {
        await devLogin.mutateAsync({ data: { email, display_name: displayName ?? null } });
        await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
      },
      signOut: async () => {
        await logout.mutateAsync();
        if (clerk.isSignedIn) {
          await clerk.signOut();
        }
        queryClient.clear();
      },
    };
  }, [me, meQuery.isLoading, clerk, isBridging, needsBridge, devLogin, logout, queryClient]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
