/**
 * Tiny pub-sub auth store. localStorage-backed so a refresh keeps the
 * session without round-tripping the IdP on every page load.
 *
 * NOT a security boundary — the backend's AuthGuard verifies the JWT
 * on every request. This store just caches what we already have.
 */
export interface AuthState {
  token: string | null;
  orgId: string | null;
  userId: string | null;
  role: 'admin' | 'reviewer' | 'employee' | 'consultant' | 'system' | null;
}

const KEY = 'br.auth';

function load(): AuthState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const v = JSON.parse(raw);
    return {
      token: typeof v.token === 'string' ? v.token : null,
      orgId: typeof v.orgId === 'string' ? v.orgId : null,
      userId: typeof v.userId === 'string' ? v.userId : null,
      role: v.role ?? null,
    };
  } catch {
    return empty();
  }
}

function empty(): AuthState {
  return { token: null, orgId: null, userId: null, role: null };
}

type Listener = (s: AuthState) => void;

class AuthStore {
  private state: AuthState = load();
  private listeners = new Set<Listener>();

  get(): AuthState { return this.state; }

  set(next: AuthState): void {
    this.state = next;
    try {
      if (next.token) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch { /* private mode */ }
    for (const l of this.listeners) l(next);
  }

  clear(): void { this.set(empty()); }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}

export const authStore = new AuthStore();
