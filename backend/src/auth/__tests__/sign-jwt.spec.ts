import { generateKeyPairSync } from 'node:crypto';
import { JwtSigningError, parsePrivateKey, signJwt } from '../sign-jwt';
import { verifyJwt } from '../jwt-verifier';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

describe('parsePrivateKey', () => {
  it('parses a valid PEM', () => {
    const k = parsePrivateKey(PRIVATE_PEM);
    expect(k.type).toBe('private');
  });

  it('throws JwtSigningError on missing input', () => {
    expect(() => parsePrivateKey('')).toThrow(JwtSigningError);
  });

  it('throws JwtSigningError with code NO_PRIVATE_KEY on non-PEM input', () => {
    let caught: JwtSigningError | null = null;
    try {
      parsePrivateKey('not a pem');
    } catch (e) {
      caught = e as JwtSigningError;
    }
    expect(caught).toBeInstanceOf(JwtSigningError);
    expect(caught?.code).toBe('NO_PRIVATE_KEY');
  });

  it('throws JwtSigningError on garbled PEM', () => {
    const bad = '-----BEGIN PRIVATE KEY-----\nnot-base64\n-----END PRIVATE KEY-----';
    expect(() => parsePrivateKey(bad)).toThrow(JwtSigningError);
  });
});

describe('signJwt', () => {
  const claims = {
    iss: 'https://api.example.com',
    aud: 'billing-rules-frontend',
    sub: '11111111-1111-4111-8111-111111111111',
    org_id: '22222222-2222-4222-8222-222222222222',
    role: 'admin',
    ttlSec: 3600,
  };
  const key = parsePrivateKey(PRIVATE_PEM);

  it('produces a verifiable RS256 token', async () => {
    const token = signJwt({ claims, privateKey: key });
    expect(token.split('.')).toHaveLength(3);
    const verified = await verifyJwt({
      token,
      publicKeyPem: PUBLIC_PEM,
      expectedIssuer: claims.iss,
      expectedAudience: claims.aud,
    });
    expect(verified.sub).toBe(claims.sub);
    expect(verified.org_id).toBe(claims.org_id);
    expect(verified.role).toBe(claims.role);
  });

  it('honors the kid header', async () => {
    const token = signJwt({ claims, privateKey: key, kid: 'sess-1' });
    const headerB64 = token.split('.')[0];
    const header = JSON.parse(
      Buffer.from(headerB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    expect(header.kid).toBe('sess-1');
    expect(header.alg).toBe('RS256');
  });

  it('emits exp = iat + ttlSec', () => {
    const now = 1_700_000_000;
    const token = signJwt({ claims, privateKey: key, nowSec: now });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      ),
    );
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBe(now + claims.ttlSec);
  });

  it('rejects an expired token at verify time', async () => {
    const oldNow = Math.floor(Date.now() / 1000) - 7200; // 2h ago
    const token = signJwt({
      claims: { ...claims, ttlSec: 60 }, // 60s ttl, signed 2h ago
      privateKey: key,
      nowSec: oldNow,
    });
    await expect(
      verifyJwt({
        token,
        publicKeyPem: PUBLIC_PEM,
        expectedIssuer: claims.iss,
        expectedAudience: claims.aud,
      }),
    ).rejects.toThrow();
  });
});
