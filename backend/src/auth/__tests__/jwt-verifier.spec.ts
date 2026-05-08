/**
 * JWT verifier tests — generates a real RSA keypair via Node crypto,
 * signs a token by hand, then verifies. Real cryptographic round-trip,
 * no fixtures. Phase 29: verifier is async (keyResolver path), so all
 * call sites use await.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { JwtVerifyError, verifyJwt } from '../jwt-verifier';

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

function signRs256(claims: Record<string, unknown>, privateKeyPem: string, headerOverride: Record<string, unknown> = {}): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...headerOverride }));
  const payload = b64url(JSON.stringify(claims));
  const signed = `${header}.${payload}`;
  const sig = createSign('RSA-SHA256').update(signed, 'utf8').sign(privateKeyPem).toString('base64url');
  return `${signed}.${sig}`;
}

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

describe('verifyJwt — RS256 round-trip', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  async function expectCode(fn: () => Promise<unknown>, code: string) {
    try {
      await fn();
      throw new Error(`expected throw with code=${code}, got no throw`);
    } catch (e) {
      if (!(e instanceof JwtVerifyError)) {
        throw e;
      }
      expect(e.code).toBe(code);
    }
  }

  it('verifies a fresh, well-formed token + extracts claims', async () => {
    const token = signRs256(
      { iss: 'https://idp.example.com', sub: 'user-1', exp: NOW_S + 3600, custom: 'value' },
      privateKey,
    );
    const claims = await verifyJwt({
      token,
      publicKeyPem: publicKey,
      expectedIssuer: 'https://idp.example.com',
      nowMs: NOW_MS,
    });
    expect(claims.sub).toBe('user-1');
    expect(claims.custom).toBe('value');
  });

  it('rejects malformed token', async () => {
    await expect(
      verifyJwt({ token: 'not.a.valid.token', publicKeyPem: publicKey, nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(JwtVerifyError);
  });

  it('rejects 2-segment token', async () => {
    await expectCode(
      () => verifyJwt({ token: 'a.b', publicKeyPem: publicKey, nowMs: NOW_MS }),
      'MALFORMED',
    );
  });

  it('rejects HS256 algorithm', async () => {
    const token = signRs256({ exp: NOW_S + 3600 }, privateKey, { alg: 'HS256' });
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: publicKey, nowMs: NOW_MS }),
      'ALG_NOT_ALLOWED',
    );
  });

  it('rejects "none" algorithm', async () => {
    const token = signRs256({ exp: NOW_S + 3600 }, privateKey, { alg: 'none' });
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: publicKey, nowMs: NOW_MS }),
      'ALG_NOT_ALLOWED',
    );
  });

  it('rejects expired token', async () => {
    const token = signRs256({ exp: NOW_S - 3600 }, privateKey);
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: publicKey, nowMs: NOW_MS }),
      'EXPIRED',
    );
  });

  it('accepts token expired within clockSkewSec window', async () => {
    const token = signRs256({ exp: NOW_S - 10 }, privateKey);
    const claims = await verifyJwt({
      token,
      publicKeyPem: publicKey,
      nowMs: NOW_MS,
      clockSkewSec: 30,
    });
    expect(claims).toBeDefined();
  });

  it('rejects nbf in future beyond skew', async () => {
    const token = signRs256({ nbf: NOW_S + 600 }, privateKey);
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: publicKey, nowMs: NOW_MS }),
      'NOT_YET_VALID',
    );
  });

  it('rejects bad signature (token signed with different key)', async () => {
    const otherPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const token = signRs256({ exp: NOW_S + 3600 }, otherPair.privateKey);
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: publicKey, nowMs: NOW_MS }),
      'BAD_SIGNATURE',
    );
  });

  it('rejects when issuer does not match', async () => {
    const token = signRs256({ iss: 'attacker.com', exp: NOW_S + 3600 }, privateKey);
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: publicKey, expectedIssuer: 'idp.example.com', nowMs: NOW_MS }),
      'ISSUER_MISMATCH',
    );
  });

  it('audience: exact match passes', async () => {
    const token = signRs256({ aud: 'api.example.com', exp: NOW_S + 3600 }, privateKey);
    await expect(
      verifyJwt({ token, publicKeyPem: publicKey, expectedAudience: 'api.example.com', nowMs: NOW_MS }),
    ).resolves.toBeDefined();
  });

  it('audience: array includes match passes', async () => {
    const token = signRs256({ aud: ['x', 'api.example.com', 'y'], exp: NOW_S + 3600 }, privateKey);
    await expect(
      verifyJwt({ token, publicKeyPem: publicKey, expectedAudience: 'api.example.com', nowMs: NOW_MS }),
    ).resolves.toBeDefined();
  });

  it('audience: mismatch rejected', async () => {
    const token = signRs256({ aud: 'other', exp: NOW_S + 3600 }, privateKey);
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: publicKey, expectedAudience: 'api.example.com', nowMs: NOW_MS }),
      'AUDIENCE_MISMATCH',
    );
  });

  it('rejects garbage public key', async () => {
    const token = signRs256({ exp: NOW_S + 3600 }, privateKey);
    await expectCode(
      () => verifyJwt({ token, publicKeyPem: '-----BEGIN GARBAGE-----', nowMs: NOW_MS }),
      'KEY_INVALID',
    );
  });
});
