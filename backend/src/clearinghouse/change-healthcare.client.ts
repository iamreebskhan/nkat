/**
 * Change Healthcare API client.
 *
 * Change Healthcare (now Optum) uses OAuth2 client_credentials over
 * `https://apis.changehealthcare.com/v1/oauth/token`. Each customer
 * registers an app in Change's developer portal, gets a clientId +
 * clientSecret, and we use those to mint access tokens.
 *
 * Same shape as `AvailityClient` so the credential service can stay
 * generic. The clearinghouse-specific call paths (eligibility,
 * claims, ERA) live in the controllers that use them.
 */

export interface ChangeHealthcareCreds {
  clientId: string;
  clientSecret: string;
}

export interface ChangeHealthcareClientOptions {
  baseUrl?: string;
  tokenUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  nowMs?: () => number;
}

interface CachedToken {
  access_token: string;
  expires_at_ms: number;
}

const DEFAULT_BASE = 'https://apis.changehealthcare.com';
const DEFAULT_TOKEN_PATH = '/v1/oauth/token';

export class ChangeHealthcareClient {
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly nowMs: () => number;
  private cached: CachedToken | null = null;

  constructor(
    private readonly creds: ChangeHealthcareCreds,
    opts: ChangeHealthcareClientOptions = {},
  ) {
    if (!creds.clientId || !creds.clientSecret) {
      throw new Error('ChangeHealthcareClient: clientId + clientSecret required');
    }
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.tokenUrl = opts.tokenUrl ?? `${this.baseUrl}${DEFAULT_TOKEN_PATH}`;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  async accessToken(): Promise<string> {
    const now = this.nowMs();
    if (this.cached && this.cached.expires_at_ms > now + 30_000) {
      return this.cached.access_token;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    const r = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new ClearinghouseError('TOKEN_MINT_FAILED', r.status, txt.slice(0, 500));
    }
    const json = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token || typeof json.expires_in !== 'number') {
      throw new ClearinghouseError(
        'TOKEN_RESPONSE_SHAPE',
        r.status,
        JSON.stringify(json).slice(0, 500),
      );
    }
    this.cached = {
      access_token: json.access_token,
      expires_at_ms: now + json.expires_in * 1000,
    };
    return json.access_token;
  }

  async ping(): Promise<{ ok: true; expires_in_sec: number }> {
    await this.accessToken();
    if (!this.cached) {
      throw new ClearinghouseError('TOKEN_MINT_FAILED', 0, 'no token cached after mint');
    }
    return {
      ok: true,
      expires_in_sec: Math.max(0, Math.floor((this.cached.expires_at_ms - this.nowMs()) / 1000)),
    };
  }

  _resetTokenCache(): void { this.cached = null; }
}

export class ClearinghouseError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Clearinghouse ${code} (status ${status}): ${detail}`);
    this.name = 'ClearinghouseError';
  }
}
