// Session + workspace context backed by the real API.
//
// On mount we query `/api/v1/me`; a 401 means "not signed in".
// After sign-in (development dev-login) the session cookie is set by the
// backend and all subsequent requests are authenticated.

import React, { createContext, useContext, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMe,
  getMeQueryKey,
  useDevLogin,
  useLogout,
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

  const value = useMemo<SessionContextValue>(() => {
    const workspace = me?.workspaces?.[0] ?? null;
    return {
      me,
      user: me?.user ?? null,
      workspace,
      workspaceId: workspace?.id ?? null,
      isLoading: meQuery.isLoading,
      isAuthenticated: Boolean(me?.user),
      signIn: async (email: string, displayName?: string) => {
        await devLogin.mutateAsync({ data: { email, display_name: displayName ?? null } });
        await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
      },
      signOut: async () => {
        await logout.mutateAsync();
        queryClient.clear();
      },
    };
  }, [me, meQuery.isLoading, devLogin, logout, queryClient]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
