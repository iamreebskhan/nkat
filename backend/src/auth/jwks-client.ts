/**
 * JWKS (JSON Web Key Set) fetcher + cache.
 *
 * IdP rotates signing keys by publishing a JWKS document at a stable
 * URL (Auth0: `/.well-known/jwks.json`; Cognito: `/.well-known/jwks.json`;
 * Okta: `/oauth2/default/v1/keys`). Each JWT carries a `kid` (key id)
 * in its header; we look that kid up in the JWKS doc + verify with
 * the matching key.
 *
 * Cache rules:
 *   - 24h TTL after a successful fetch.
 *   - On `kid` miss, force-refresh ONCE (key rotation just happened),
 *     then re-look-up. If still missing, throw.
 *   - Single in-flight fetch shared across concurrent callers (a
 *     thundering herd of API tasks all see the same kid-miss → only
 *     one HTTP fetch happens).
 *   - Cap at 32 keys per JWKS doc (a paranoid bound — real IdPs ship 1-5).
 *
 * URL allowlist is the caller's responsibility — the JwksClient is
 * constructed with a single fixed URL, not user input.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { Logger } from '@nestjs/common';

export interface JwkRsa {
  kty: 'RSA';
  use?: string;
  alg?: string;
  kid: string;
  n: string;
  e: string;
}

export interface JwkEc {
  kty: 'EC';
  crv: string; // P-256, P-384, P-521
  use?: string;
  alg?: string;
  kid: string;
  x: string;
  y: string;
}

export type Jwk = JwkRsa | JwkEc;

export interface JwksDocument {
  keys: Jwk[];
}

export class JwksError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'JwksError';
  }
}

/**
 * Resolved key entry: the public key + the IdP's declared algorithm.
 * Production IdPs (Auth0, Cognito, Okta) always set `alg` on each JWK.
 * The caller (verifyJwt) cross-checks this against the JWT header's
 * `alg` claim to prevent algorithm-confusion attacks.
 */
export interface ResolvedKey {
  key: KeyObject;
  /** JWK's declared algorithm. Undefined when the IdP omitted it. */
  alg: string | undefined;
}

interface CacheEntry {
  byKid: Map<string, ResolvedKey>;
  expiresAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 32;

export class JwksClient {
  private readonly log = new Logger(JwksClient.name);
  private cache: CacheEntry | null = null;
  private inFlight: Promise<CacheEntry> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
    private readonly nowFn: () => number = Date.now,
  ) {
    if (!url) throw new Error('JwksClient: url is required');
  }

  /**
   * Resolve the public key for `kid`. Force-refreshes once on miss
   * (the IdP just rotated and our cache is stale).
   */
  async resolveKey(kid: string): Promise<ResolvedKey> {
    if (!kid) throw new JwksError('NO_KID', 'JWT header missing kid');

    let entry = await this.getCacheEntry();
    let resolved = entry.byKid.get(kid);
    if (resolved) return resolved;

    // Miss → force-refresh once.
    this.cache = null;
    this.inFlight = null;
    entry = await this.getCacheEntry();
    resolved = entry.byKid.get(kid);
    if (!resolved) {
      throw new JwksError('KID_NOT_FOUND', `kid ${kid} not in JWKS`);
    }
    return resolved;
  }

  /** Visible for tests — clears the cache so the next resolveKey re-fetches. */
  _resetCache(): void {
    this.cache = null;
    this.inFlight = null;
  }

  /**
   * Eagerly fetch the JWKS document so the first inbound JWT doesn't
   * pay cold-fetch latency. Called from AuthModule.onApplicationBootstrap.
   * Failures are non-fatal — first JWT request will retry.
   */
  async prewarm(): Promise<{ ok: boolean; keyCount: number; error?: string }> {
    const t0 = Date.now();
    try {
      const entry = await this.getCacheEntry();
      this.log.log(`prewarm ok: ${entry.byKid.size} key(s) cached`);
      this.metricsHook?.timing('billing_rules.auth.jwks_fetch_ms', Date.now() - t0);
      return { ok: true, keyCount: entry.byKid.size };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`prewarm failed: ${msg}`);
      return { ok: false, keyCount: 0, error: msg };
    }
  }

  /**
   * Optional metrics hook — set by AuthModule's prewarmer to feed
   * `billing_rules.auth.jwks_fetch_ms` to Datadog. Kept as a setter
   * to avoid wiring MetricsService through the JwksClient constructor
   * (which has no DI context).
   */
  setMetricsHook(h: { timing(name: string, ms: number): void }): void {
    this.metricsHook = h;
  }
  private metricsHook: { timing(name: string, ms: number): void } | null = null;

  private async getCacheEntry(): Promise<CacheEntry> {
    const now = this.nowFn();
    if (this.cache && this.cache.expiresAt > now) return this.cache;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchAndCache();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetchAndCache(): Promise<CacheEntry> {
    const r = await this.fetchImpl(this.url, { method: 'GET' });
    if (!r.ok) {
      throw new JwksError('FETCH_FAILED', `JWKS ${r.status} from ${this.url}`);
    }
    let doc: JwksDocument;
    try {
      doc = (await r.json()) as JwksDocument;
    } catch {
      throw new JwksError('NOT_JSON', 'JWKS response was not JSON');
    }
    if (!doc || !Array.isArray(doc.keys)) {
      throw new JwksError('SHAPE', 'JWKS missing keys[]');
    }
    if (doc.keys.length > MAX_KEYS) {
      throw new JwksError('TOO_MANY_KEYS', `JWKS has ${doc.keys.length} keys (cap ${MAX_KEYS})`);
    }
    const byKid = new Map<string, ResolvedKey>();
    for (const jwk of doc.keys) {
      try {
        // Filter to signing keys only (Auth0/Cognito sometimes ship
        // encryption keys in the same doc with use='enc').
        if (jwk.use && jwk.use !== 'sig') continue;
        if (!jwk.kid) continue;
        const key = jwkToPublicKey(jwk);
        byKid.set(jwk.kid, { key, alg: jwk.alg });
      } catch (e) {
        this.log.warn(`skipping malformed JWK kid=${jwk.kid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (byKid.size === 0) {
      throw new JwksError('NO_USABLE_KEYS', 'JWKS contained no usable signing keys');
    }
    const entry: CacheEntry = { byKid, expiresAt: this.nowFn() + TTL_MS };
    this.cache = entry;
    this.log.log(`fetched JWKS from ${this.url}: ${entry.byKid.size} signing key(s)`);
    return entry;
  }
}

/**
 * Convert a JWK to a Node `KeyObject`. Node 18+ supports `format: 'jwk'`
 * directly via `createPublicKey`, which handles RSA and EC natively.
 */
export function jwkToPublicKey(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
}
