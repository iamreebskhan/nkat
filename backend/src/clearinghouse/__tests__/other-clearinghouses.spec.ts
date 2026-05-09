import { ChangeHealthcareClient, ClearinghouseError } from '../change-healthcare.client';
import { WaystarClient } from '../waystar.client';

function fetchSequence(responses: { status: number; body: unknown }[]) {
  let i = 0;
  return ((..._args: unknown[]) => {
    const r = responses[i++];
    if (!r) throw new Error(`fetch called more than expected (${i})`);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    } as Response);
  }) as unknown as typeof globalThis.fetch;
}

const CREDS = { clientId: 'c-id', clientSecret: 'c-sec' };

describe.each([
  [
    'ChangeHealthcareClient',
    (creds: typeof CREDS, fi: typeof globalThis.fetch, now: () => number) =>
      new ChangeHealthcareClient(creds, { fetchImpl: fi, nowMs: now }),
  ],
  [
    'WaystarClient',
    (creds: typeof CREDS, fi: typeof globalThis.fetch, now: () => number) =>
      new WaystarClient(creds, { fetchImpl: fi, nowMs: now }),
  ],
])('%s OAuth2 token flow', (_name, mk) => {
  it('mints + caches a token', async () => {
    const fi = fetchSequence([{ status: 200, body: { access_token: 'tok-1', expires_in: 3600 } }]);
    const c = mk(CREDS, fi, () => 1_700_000_000_000);
    expect(await c.accessToken()).toBe('tok-1');
    expect(await c.accessToken()).toBe('tok-1');
  });

  it('refreshes when within 30s of expiry', async () => {
    let now = 1_700_000_000_000;
    const fi = fetchSequence([
      { status: 200, body: { access_token: 'tok-A', expires_in: 60 } },
      { status: 200, body: { access_token: 'tok-B', expires_in: 60 } },
    ]);
    const c = mk(CREDS, fi, () => now);
    expect(await c.accessToken()).toBe('tok-A');
    now += 35_000;
    expect(await c.accessToken()).toBe('tok-B');
  });

  it('throws on a 401 from the token endpoint', async () => {
    const fi = fetchSequence([{ status: 401, body: 'invalid_client' }]);
    const c = mk(CREDS, fi, () => 1);
    await expect(c.accessToken()).rejects.toBeInstanceOf(ClearinghouseError);
  });

  it('throws on token-shape mismatch', async () => {
    const fi = fetchSequence([{ status: 200, body: { not_a_token: 'x' } }]);
    const c = mk(CREDS, fi, () => 1);
    await expect(c.accessToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_SHAPE' });
  });

  it('ping returns ok + remaining-seconds', async () => {
    const fi = fetchSequence([{ status: 200, body: { access_token: 't', expires_in: 600 } }]);
    const c = mk(CREDS, fi, () => 1_700_000_000_000);
    const r = await c.ping();
    expect(r.ok).toBe(true);
    expect(r.expires_in_sec).toBeGreaterThan(0);
  });
});

describe('rejects empty creds', () => {
  it('ChangeHealthcareClient', () => {
    expect(() => new ChangeHealthcareClient({ clientId: '', clientSecret: '' })).toThrow();
  });
  it('WaystarClient', () => {
    expect(() => new WaystarClient({ clientId: '', clientSecret: '' })).toThrow();
  });
});
