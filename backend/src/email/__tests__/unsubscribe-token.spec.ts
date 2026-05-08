import { signUnsubscribeToken, verifyUnsubscribeToken } from '../unsubscribe-token';

const SECRET = 'unsub_secret_value_minimum_length_32_chars_or_so';
const NOW_MS = 1_700_000_000_000;

describe('signUnsubscribeToken / verifyUnsubscribeToken — round trip', () => {
  it('signs + verifies a fresh token', () => {
    const t = signUnsubscribeToken({
      payload: { email: 'A@example.com', scope: 'manual_optout' },
      secret: SECRET,
      nowMs: NOW_MS,
    });
    const r = verifyUnsubscribeToken({ token: t, secret: SECRET, nowMs: NOW_MS, expectScope: 'manual_optout' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.email).toBe('a@example.com');  // lower-cased on sign
      expect(r.payload.scope).toBe('manual_optout');
    }
  });

  it('rejects expired token', () => {
    const t = signUnsubscribeToken({
      payload: { email: 'a@x', scope: 'manual_optout', exp: Math.floor(NOW_MS / 1000) - 60 },
      secret: SECRET,
      nowMs: NOW_MS,
    });
    const r = verifyUnsubscribeToken({ token: t, secret: SECRET, nowMs: NOW_MS });
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects bad signature', () => {
    const t = signUnsubscribeToken({
      payload: { email: 'a@x', scope: 'manual_optout' },
      secret: SECRET,
      nowMs: NOW_MS,
    });
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const r = verifyUnsubscribeToken({ token: tampered, secret: SECRET, nowMs: NOW_MS });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects bad signature when secret differs', () => {
    const t = signUnsubscribeToken({
      payload: { email: 'a@x', scope: 'manual_optout' },
      secret: SECRET,
      nowMs: NOW_MS,
    });
    expect(verifyUnsubscribeToken({ token: t, secret: 'OTHER', nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects malformed', () => {
    expect(verifyUnsubscribeToken({ token: 'no-dot', secret: SECRET })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyUnsubscribeToken({ token: '', secret: SECRET })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyUnsubscribeToken({ token: '.x', secret: SECRET })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects wrong-scope when expectScope supplied', () => {
    const t = signUnsubscribeToken({
      // Cast intentionally — we want to forge a different scope at sign-time
      // to exercise the verify guard (in production sign() is type-safe).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: { email: 'a@x', scope: 'something_else' as any },
      secret: SECRET,
      nowMs: NOW_MS,
    });
    expect(
      verifyUnsubscribeToken({ token: t, secret: SECRET, nowMs: NOW_MS, expectScope: 'manual_optout' }),
    ).toEqual({ ok: false, reason: 'wrong_scope' });
  });

  it('default TTL is 90 days', () => {
    const t = signUnsubscribeToken({
      payload: { email: 'a@x', scope: 'manual_optout' },
      secret: SECRET,
      nowMs: NOW_MS,
    });
    // 89 days from issue: still valid
    const ok = verifyUnsubscribeToken({ token: t, secret: SECRET, nowMs: NOW_MS + 89 * 86_400_000 });
    expect(ok.ok).toBe(true);
    // 91 days: expired
    const expired = verifyUnsubscribeToken({ token: t, secret: SECRET, nowMs: NOW_MS + 91 * 86_400_000 });
    expect(expired.ok).toBe(false);
  });
});
