/**
 * Tiny typed fetch wrapper. No SDK — `fetch` + a hand-rolled error
 * model is plenty given our endpoint surface.
 *
 * Handles:
 *   - JSON encode/decode
 *   - Auth token attachment (read from `authStore`)
 *   - 401 → clear token + redirect (caller can override)
 *   - Structured error throwing with `code` + `status` + `body`
 */
import { authStore } from '../auth/auth-store';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** Override the global 401 handler for this call. */
  on401?: 'redirect' | 'throw';
  /** AbortSignal — TanStack Query plumbs this in. */
  signal?: AbortSignal;
}

const BASE = '';

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return BASE + path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return BASE + path + (qs ? `?${qs}` : '');
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...opts.headers,
  };
  const auth = authStore.get();
  if (auth.token) {
    // Two-mode auth handoff:
    //   1. dev-header tokens are the synthetic
    //      `devheader.<orgId>.<userId>.<role>` strings minted by
    //      LoginPage when AUTH_MODE=dev_header on the backend. The
    //      backend AuthGuard expects X-Org-Id / X-User-Id / X-Role
    //      headers in that mode, NOT a Bearer token.
    //   2. Real JWTs (from the OIDC SSO callback) go in
    //      Authorization: Bearer.
    if (auth.token.startsWith('devheader.')) {
      if (auth.orgId)  headers['X-Org-Id']  = auth.orgId;
      if (auth.userId) headers['X-User-Id'] = auth.userId;
      if (auth.role)   headers['X-Role']    = auth.role;
    } else {
      headers.Authorization = `Bearer ${auth.token}`;
    }
  }

  const r = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: 'include',
  });

  if (r.status === 204) return undefined as unknown as T;
  const ctype = r.headers.get('content-type') ?? '';
  let data: unknown = null;
  if (ctype.includes('application/json')) {
    try { data = await r.json(); } catch { /* tolerate */ }
  } else if (ctype.includes('application/pdf')) {
    return (await r.blob()) as unknown as T;
  } else {
    data = await r.text();
  }

  if (!r.ok) {
    if (r.status === 401 && (opts.on401 ?? 'redirect') === 'redirect') {
      authStore.set({ token: null, orgId: null, userId: null, role: null });
      // Keep the current URL so login can return us afterward.
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/login?next=${next}`);
    }
    const code = (data as { code?: string } | null)?.code ?? `HTTP_${r.status}`;
    const message = (data as { message?: string } | null)?.message ?? r.statusText;
    throw new ApiError(r.status, code, message, data);
  }

  return data as T;
}

/** Thin sugar so React-Query call sites read cleanly. */
export const apiGet  = <T>(path: string, query?: RequestOptions['query']) => api<T>(path, { method: 'GET', query });
export const apiPost = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const apiPut  = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const apiPatch= <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const apiDel  = <T>(path: string) => api<T>(path, { method: 'DELETE' });
