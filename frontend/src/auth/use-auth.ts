import { useSyncExternalStore } from 'react';
import { authStore, type AuthState } from './auth-store';

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => authStore.subscribe(cb),
    () => authStore.get(),
    () => authStore.get(),
  );
}

export function isAuthed(s: AuthState): boolean {
  return Boolean(s.token && s.orgId);
}
