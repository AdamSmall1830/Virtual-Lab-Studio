import { useMemo } from 'react';
import {
  useListWorkers,
  getListWorkersQueryKey,
  type RecursiveWorkerOut,
} from '@/api';
import { recursiveAvailability, type RecursiveAvailability } from '@/lib/recursive';

export interface RecursiveWorkersState {
  availability: RecursiveAvailability;
  workers: RecursiveWorkerOut[];
  isLoading: boolean;
  refetch: () => void;
}

/**
 * One query answers every "can I use recursive execution?" question.
 *
 * The server removes the whole recursive router when the feature is disabled,
 * so the outcome of this single request separates "not built into this
 * deployment" (404) from "built in, but nothing is connected" (200 with an
 * empty or stale list). No separate capability endpoint is needed, and there
 * is no state in which the UI has to guess.
 *
 * Polling is deliberate and slow: a worker's liveness is derived from a
 * timestamp, so without a refetch the page would keep claiming a machine is
 * online long after it stopped answering.
 */
export function useRecursiveWorkers(
  workspaceId: string | null,
  options: { pollMs?: number } = {},
): RecursiveWorkersState {
  const enabled = Boolean(workspaceId);
  const wsId = workspaceId ?? '';
  const query = useListWorkers(wsId, {
    query: {
      queryKey: getListWorkersQueryKey(wsId),
      enabled,
      refetchInterval: options.pollMs ?? 30_000,
      retry: false,
    },
  });

  const availability = useMemo(
    () =>
      recursiveAvailability({
        isLoading: !enabled || query.isLoading,
        error: query.error,
        workers: query.data,
      }),
    [enabled, query.isLoading, query.error, query.data],
  );

  return {
    availability,
    workers: query.data ?? [],
    isLoading: query.isLoading,
    refetch: () => void query.refetch(),
  };
}
