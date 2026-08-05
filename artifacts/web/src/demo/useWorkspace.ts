// React bindings for the demo workspace store.
import { useSyncExternalStore } from 'react';
import { getState, subscribe } from './store';
import type { WorkspaceState } from './types';

/** Subscribe a component to the whole workspace state (re-renders on any mutation). */
export function useWorkspace(): WorkspaceState {
  return useSyncExternalStore(subscribe, getState, getState);
}
