/**
 * JwksClient tests — generates a real RSA keypair, exports as JWK,
 * serves it from a fake fetch, then verifies the resolveKey path
 * including TTL caching, force-refresh on miss, and concurrent fetch
 * coalescing.
 */
import { createSign, createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { JwksClient } from '../jwks-client';

/** Generate a fresh keypair, return both KeyObjects. */
function genRsa(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function jwkOf(pk: KeyObject, kid: string, use: 'sig' | 'enc' = 'sig') {
  // KeyObject.export({format:'jwk'}) returns the JWK shape Node speaks.
  // We add kid + use ourselves.
  const jwk = pk.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, use, alg: 'RS256' };
}

function fakeFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>): {
  fn: typeof globalThis.fetch;
  callCount: () => number;
} {
  let i = 0;
  const fn = jest.fn().mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, callCount: () => i };
}

const URL = 'https://idp.example.com/.well-known/jwks.json';

describe('JwksClient', () => {
  it('throws on construction without url', () => {
    expect(() => new JwksClient('')).toThrow();
  });

  it('resolveKey returns a key that round-trips a real signature', async () => {
    const { publicKey, privateKey } = genRsa();
    const { fn, callCount } = fakeFetch([{ ok: true, body: { keys: [jwkOf(publicKey, 'k-1')] } }]);
    const client = new JwksClient(URL, fn);
    const k = await client.resolveKey('k-1');
    const sig = createSign('RSA-SHA256').update('hello', 'utf8').sign(privateKey);
    expect(createVerify('RSA-SHA256').update('hello', 'utf8').verify(k, sig)).toBe(true);
    // Cached: second resolveKey hits the cache, no second fetch.
    await client.resolveKey('k-1');
    expect(callCount()).toBe(1);
  });

  it('on kid miss, force-refreshes once', async () => {
    const old = genRsa();
    const fresh = genRsa();
    const { fn, callCount } = fakeFetch([
      { ok: true, body: { keys: [jwkOf(old.publicKey, 'old-kid')] } },
      { ok: true, body: { keys: [jwkOf(fresh.publicKey, 'new-kid')] } },
    ]);
    const client = new JwksClient(URL, fn);
    await client.resolveKey('old-kid');
    expect(callCount()).toBe(1);
    const k = await client.resolveKey('new-kid');
    expect(k).toBeDefined();
    expect(callCount()).toBe(2);
  });

  it('throws KID_NOT_FOUND when neither cache nor refresh has the kid', async () => {
    const { publicKey } = genRsa();
    const { fn, callCount } = fakeFetch([
      { ok: true, body: { keys: [jwkOf(publicKey, 'k1')] } },
    ]);
    const client = new JwksClient(URL, fn);
    await expect(client.resolveKey('nope')).rejects.toMatchObject({ code: 'KID_NOT_FOUND' });
    // Force-refresh fired exactly once; both fetches returned the same doc.
    expect(callCount()).toBe(2);
  });

  it('throws NO_KID on empty kid', async () => {
    const { fn } = fakeFetch([{ ok: true, body: { keys: [] } }]);
    const client = new JwksClient(URL, fn);
    await expect(client.resolveKey('')).rejects.toMatchObject({ code: 'NO_KID' });
  });

  it('throws FETCH_FAILED on non-2xx', async () => {
    const { fn } = fakeFetch([{ ok: false, status: 503, body: 'unavailable' }]);
    const client = new JwksClient(URL, fn);
    await expect(client.resolveKey('any')).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('skips encryption keys (use=enc) when looking up a sig kid', async () => {
    const enc = genRsa();
    const sig = genRsa();
    const { fn } = fakeFetch([
      {
        ok: true,
        body: {
          keys: [
            jwkOf(enc.publicKey, 'enc-kid', 'enc'),
            jwkOf(sig.publicKey, 'sig-kid', 'sig'),
          ],
        },
      },
    ]);
    const client = new JwksClient(URL, fn);
    // The enc-kid is filtered out → not found even though it's in the doc.
    await expect(client.resolveKey('enc-kid')).rejects.toMatchObject({ code: 'KID_NOT_FOUND' });
    // sig-kid is usable.
    const k = await client.resolveKey('sig-kid');
    expect(k).toBeDefined();
  });

  it('rejects JWKS doc with too many keys', async () => {
    const { fn } = fakeFetch([
      {
        ok: true,
        body: {
          keys: Array.from({ length: 64 }, (_, i) => ({ kty: 'RSA', kid: `k${i}`, n: 'x', e: 'AQAB', use: 'sig' })),
        },
      },
    ]);
    const client = new JwksClient(URL, fn);
    await expect(client.resolveKey('k0')).rejects.toMatchObject({ code: 'TOO_MANY_KEYS' });
  });

  it('throws NO_USABLE_KEYS when all keys are encryption-only', async () => {
    const enc = genRsa();
    const { fn } = fakeFetch([
      { ok: true, body: { keys: [jwkOf(enc.publicKey, 'enc', 'enc')] } },
    ]);
    const client = new JwksClient(URL, fn);
    await expect(client.resolveKey('enc')).rejects.toMatchObject({ code: 'NO_USABLE_KEYS' });
  });

  it('coalesces concurrent in-flight fetches', async () => {
    const { publicKey } = genRsa();
    const { fn, callCount } = fakeFetch([
      { ok: true, body: { keys: [jwkOf(publicKey, 'k1')] } },
    ]);
    const client = new JwksClient(URL, fn);
    const [a, b, c] = await Promise.all([
      client.resolveKey('k1'),
      client.resolveKey('k1'),
      client.resolveKey('k1'),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    expect(callCount()).toBe(1);
  });

  it('verifyJwt rejects ALG_KEY_MISMATCH when JWK declares different alg than header', async () => {
    const { verifyJwt } = await import('../jwt-verifier');
    const { publicKey, privateKey } = genRsa();
    // JWK declares alg=ES256 but the actual key is RSA — synthetic
    // mismatch that an IdP would never produce, but exactly the kind
    // of gotcha an attacker would manufacture if they could.
    const fixedJwk = { ...jwkOf(publicKey, 'k-1'), alg: 'ES256' };
    const { fn } = fakeFetch([{ ok: true, body: { keys: [fixedJwk] } }]);
    const client = new JwksClient(URL, fn);

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k-1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const signed = `${header}.${payload}`;
    const sig = createSign('RSA-SHA256').update(signed, 'utf8').sign(privateKey).toString('base64url');
    const token = `${signed}.${sig}`;

    await expect(
      verifyJwt({ token, keyResolver: (kid) => client.resolveKey(kid) }),
    ).rejects.toMatchObject({ code: 'ALG_KEY_MISMATCH' });
  });

  it('verifyJwt accepts when JWK omits alg (best-effort)', async () => {
    const { verifyJwt } = await import('../jwt-verifier');
    const { publicKey, privateKey } = genRsa();
    // Build a JWK without alg — exercises the "IdP didn't declare alg" path.
    const fullJwk = jwkOf(publicKey, 'k-1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (fullJwk as any).alg;
    const { fn } = fakeFetch([{ ok: true, body: { keys: [fullJwk] } }]);
    const client = new JwksClient(URL, fn);

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k-1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const signed = `${header}.${payload}`;
    const sig = createSign('RSA-SHA256').update(signed, 'utf8').sign(privateKey).toString('base64url');
    const token = `${signed}.${sig}`;

    const claims = await verifyJwt({ token, keyResolver: (kid) => client.resolveKey(kid) });
    expect(claims.sub).toBe('user-1');
  });

  it('end-to-end: verifyJwt with keyResolver', async () => {
    const { verifyJwt } = await import('../jwt-verifier');
    const { publicKey, privateKey } = genRsa();
    const { fn } = fakeFetch([{ ok: true, body: { keys: [jwkOf(publicKey, 'k-1')] } }]);
    const client = new JwksClient(URL, fn);
    // Sign a token with the private key, kid=k-1.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k-1' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-1', iss: 'https://idp.example.com', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const signed = `${header}.${payload}`;
    const sig = createSign('RSA-SHA256').update(signed, 'utf8').sign(privateKey).toString('base64url');
    const token = `${signed}.${sig}`;

    const claims = await verifyJwt({
      token,
      keyResolver: (kid) => client.resolveKey(kid),
      expectedIssuer: 'https://idp.example.com',
    });
    expect(claims.sub).toBe('user-1');
  });
});
