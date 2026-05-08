/**
 * Availity API client.
 *
 * Availity Essentials uses OAuth2 client-credentials. The customer
 * registers an app in their Availity portal, gets a client_id +
 * client_secret, and we use those to mint an access token, then
 * call their REST APIs:
 *
 *   POST  /v1/eligibility-and-benefits          (270 → 271)
 *   POST  /v1/claims                            (837P / 837I submission)
 *   GET   /v1/era                               (835 retrieval)
 *
 * This module is intentionally thin: token mint + a `request` wrapper.
 * Specific call shapes live in the controllers that use them.
 *
 * Tests:
 *   - Pure token expiration logic in `availity.client.spec.ts`.
 *   - The `dial`-style fetch injection lets us swap globalThis.fetch
 *     for a stub. Production passes nothing and uses native fetch.
 */
export interface AvailityCreds {
  clientId: string;
  clientSecret: string;
}

export interface AvailityClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Override the clock for tests. Defaults to Date.now. */
  nowMs?: () => number;
}

interface CachedToken {
  access_token: string;
  expires_at_ms: number;
}

const DEFAULT_BASE = 'https://api.availity.com';

export class AvailityClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly nowMs: () => number;
  private cached: CachedToken | null = null;

  constructor(
    private readonly creds: AvailityCreds,
    opts: AvailityClientOptions = {},
  ) {
    if (!creds.clientId || !creds.clientSecret) {
      throw new Error('AvailityClient: clientId + clientSecret required');
    }
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Returns a valid access token. Caches per-client_id with a 30-second
   * safety margin before expiry so an in-flight request never lands
   * with an already-expired token.
   */
  async accessToken(): Promise<string> {
    const now = this.nowMs();
    if (this.cached && this.cached.expires_at_ms > now + 30_000) {
      return this.cached.access_token;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: 'hipaa',
    });
    const r = await this.fetchImpl(`${this.baseUrl}/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new AvailityError('TOKEN_MINT_FAILED', r.status, txt.slice(0, 500));
    }
    const json = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token || typeof json.expires_in !== 'number') {
      throw new AvailityError('TOKEN_RESPONSE_SHAPE', r.status, JSON.stringify(json).slice(0, 500));
    }
    this.cached = {
      access_token: json.access_token,
      expires_at_ms: now + json.expires_in * 1000,
    };
    return json.access_token;
  }

  /**
   * Generic authenticated request. Auto-attaches Bearer + JSON.
   * Caller provides path (relative to baseUrl) + method + body.
   */
  async request<T = unknown>(args: {
    path: string;
    method: 'GET' | 'POST';
    body?: unknown;
    headers?: Record<string, string>;
    /** AbortSignal for request cancellation. */
    signal?: AbortSignal;
  }): Promise<T> {
    const token = await this.accessToken();
    const r = await this.fetchImpl(`${this.baseUrl}${args.path}`, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(args.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...args.headers,
      },
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      signal: args.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new AvailityError('REQUEST_FAILED', r.status, txt.slice(0, 500));
    }
    if (r.status === 204) return undefined as unknown as T;
    return (await r.json()) as T;
  }

  /**
   * "Test connection" — a lightweight probe used by the admin
   * UI's verify-credentials button. Mints a token; if that succeeds
   * the credentials work. Doesn't make a costly downstream call.
   */
  async ping(): Promise<{ ok: true; expires_in_sec: number }> {
    await this.accessToken();
    if (!this.cached) throw new AvailityError('TOKEN_MINT_FAILED', 0, 'no token cached after mint');
    return {
      ok: true,
      expires_in_sec: Math.max(0, Math.floor((this.cached.expires_at_ms - this.nowMs()) / 1000)),
    };
  }

  /** Test seam: drops the cached token so the next call re-mints. */
  _resetTokenCache(): void { this.cached = null; }
}

export class AvailityError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Availity ${code} (status ${status}): ${detail}`);
    this.name = 'AvailityError';
  }
}
