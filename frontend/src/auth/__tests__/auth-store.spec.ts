import { authStore } from '../auth-store';

describe('authStore', () => {
  it('starts empty when localStorage is empty', () => {
    expect(authStore.get()).toEqual({ token: null, orgId: null, userId: null, role: null });
  });

  it('persists state on set, clears on clear', () => {
    authStore.set({ token: 't', orgId: 'o', userId: 'u', role: 'admin' });
    expect(authStore.get()).toEqual({ token: 't', orgId: 'o', userId: 'u', role: 'admin' });
    authStore.clear();
    expect(authStore.get()).toEqual({ token: null, orgId: null, userId: null, role: null });
  });

  it('notifies subscribers on change', () => {
    const seen: string[] = [];
    const off = authStore.subscribe((s) => seen.push(s.token ?? '_'));
    authStore.set({ token: 'a', orgId: 'o', userId: 'u', role: 'admin' });
    authStore.clear();
    off();
    expect(seen).toEqual(['a', '_']);
  });
});
