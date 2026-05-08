import { createHmac } from 'node:crypto';
import { verifyStripeSignature } from '../stripe-hmac';
import { InvalidWebhookSignatureError } from '../billing-types';

const SECRET = 'whsec_test_secret_value_minimum_length_32_chars';
const BODY = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
const NOW_MS = 1_700_000_000_000; // fixed clock
const NOW_S = Math.floor(NOW_MS / 1000);

function sign(timestamp: number, body: string, secret = SECRET): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

describe('verifyStripeSignature', () => {
  it('accepts a fresh, well-formed signature', () => {
    const header = sign(NOW_S, BODY);
    const r = verifyStripeSignature({ header, rawBody: BODY, signingSecret: SECRET, nowMs: NOW_MS });
    expect(r.timestamp).toBe(NOW_S);
  });

  it('rejects a missing header', () => {
    expect(() =>
      verifyStripeSignature({ header: '', rawBody: BODY, signingSecret: SECRET, nowMs: NOW_MS }),
    ).toThrow(InvalidWebhookSignatureError);
  });

  it('rejects a malformed header', () => {
    expect(() =>
      verifyStripeSignature({ header: 'totally-bogus', rawBody: BODY, signingSecret: SECRET, nowMs: NOW_MS }),
    ).toThrow(/malformed/);
  });

  it('rejects when timestamp is older than tolerance', () => {
    const old = NOW_S - 600;
    const header = sign(old, BODY);
    expect(() =>
      verifyStripeSignature({ header, rawBody: BODY, signingSecret: SECRET, nowMs: NOW_MS }),
    ).toThrow(/outside tolerance/);
  });

  it('rejects when body has been tampered with', () => {
    const header = sign(NOW_S, BODY);
    expect(() =>
      verifyStripeSignature({
        header,
        rawBody: BODY.replace('evt_1', 'evt_2'),
        signingSecret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toThrow(/no matching v1/);
  });

  it('rejects when signed with the wrong secret', () => {
    const header = sign(NOW_S, BODY, 'whsec_some_other_secret_long_enough_value');
    expect(() =>
      verifyStripeSignature({ header, rawBody: BODY, signingSecret: SECRET, nowMs: NOW_MS }),
    ).toThrow(/no matching v1/);
  });

  it('accepts when the header carries multiple v1 candidates and any match', () => {
    const good = createHmac('sha256', SECRET).update(`${NOW_S}.${BODY}`).digest('hex');
    const header = `t=${NOW_S},v1=baadcafe,v1=${good}`;
    const r = verifyStripeSignature({ header, rawBody: BODY, signingSecret: SECRET, nowMs: NOW_MS });
    expect(r.timestamp).toBe(NOW_S);
    expect(r.secretIndex).toBe(0);
  });

  // ----- Rotation tests --------------------------------------------------

  const NEW_SECRET = 'whsec_NEW_secret_value_minimum_length_32_chars';
  const OLD_SECRET = 'whsec_OLD_secret_value_minimum_length_32_chars';

  it('rotation: accepts signature from primary (new) secret', () => {
    const header = sign(NOW_S, BODY, NEW_SECRET);
    const r = verifyStripeSignature({
      header,
      rawBody: BODY,
      signingSecret: [NEW_SECRET, OLD_SECRET],
      nowMs: NOW_MS,
    });
    expect(r.secretIndex).toBe(0);
  });

  it('rotation: accepts signature from previous secret + reports index 1', () => {
    const header = sign(NOW_S, BODY, OLD_SECRET);
    const r = verifyStripeSignature({
      header,
      rawBody: BODY,
      signingSecret: [NEW_SECRET, OLD_SECRET],
      nowMs: NOW_MS,
    });
    expect(r.secretIndex).toBe(1);
  });

  it('rotation: rejects signature from a secret no longer in the list', () => {
    const ABANDONED = 'whsec_abandoned_secret_value_minimum_len_32__';
    const header = sign(NOW_S, BODY, ABANDONED);
    expect(() =>
      verifyStripeSignature({
        header,
        rawBody: BODY,
        signingSecret: [NEW_SECRET, OLD_SECRET],
        nowMs: NOW_MS,
      }),
    ).toThrow(/no matching v1/);
  });

  it('rotation: empty secret list throws', () => {
    expect(() =>
      verifyStripeSignature({
        header: sign(NOW_S, BODY),
        rawBody: BODY,
        signingSecret: [],
        nowMs: NOW_MS,
      }),
    ).toThrow(/no signing secrets/);
  });

  it('rotation: list with empty-string entry throws (operator config error)', () => {
    expect(() =>
      verifyStripeSignature({
        header: sign(NOW_S, BODY),
        rawBody: BODY,
        signingSecret: [NEW_SECRET, ''],
        nowMs: NOW_MS,
      }),
    ).toThrow(/non-empty/);
  });
});
