import { AvailityClient, AvailityError } from '../availity.client';

function makeFetchSequence(responses: { status: number; body: unknown; ok?: boolean }[]) {
  let i = 0;
  return ((..._args: unknown[]) => {
    const r = responses[i++];
    if (!r) throw new Error(`fetch called more times than expected (${i})`);
    return Promise.resolve({
      ok: r.ok ?? (r.status >= 200 && r.status < 300),
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    } as Response);
  }) as unknown as typeof globalThis.fetch;
}

const CREDS = { clientId: 'client_abc', clientSecret: 's3cr3t' };

describe('AvailityClient.accessToken', () => {
  it('mints + caches a token', async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } },
    ]);
    const c = new AvailityClient(CREDS, { fetchImpl, nowMs: () => 1_700_000_000_000 });
    expect(await c.accessToken()).toBe('tok-1');
    // Second call should NOT mint again (cached).
    expect(await c.accessToken()).toBe('tok-1');
  });

  it('refreshes when within 30s of expiry', async () => {
    let now = 1_700_000_000_000;
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { access_token: 'tok-A', expires_in: 60 } },
      { status: 200, body: { access_token: 'tok-B', expires_in: 60 } },
    ]);
    const c = new AvailityClient(CREDS, { fetchImpl, nowMs: () => now });
    expect(await c.accessToken()).toBe('tok-A');
    // 35s later — within the 30s safety margin → should refresh.
    now += 35_000;
    expect(await c.accessToken()).toBe('tok-B');
  });

  it('throws AvailityError on a 401 from the token endpoint', async () => {
    const fetchImpl = makeFetchSequence([{ status: 401, body: 'invalid_client' }]);
    const c = new AvailityClient(CREDS, { fetchImpl, nowMs: () => 1 });
    await expect(c.accessToken()).rejects.toBeInstanceOf(AvailityError);
  });

  it('throws on token-shape mismatch', async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: { something_else: 'x' } }]);
    const c = new AvailityClient(CREDS, { fetchImpl, nowMs: () => 1 });
    await expect(c.accessToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_SHAPE' });
  });
});

describe('AvailityClient.ping', () => {
  it('returns ok + remaining-seconds when creds work', async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { access_token: 't', expires_in: 600 } },
    ]);
    const c = new AvailityClient(CREDS, { fetchImpl, nowMs: () => 1_700_000_000_000 });
    const r = await c.ping();
    expect(r.ok).toBe(true);
    expect(r.expires_in_sec).toBeGreaterThan(0);
    expect(r.expires_in_sec).toBeLessThanOrEqual(600);
  });
});

describe('AvailityClient.request', () => {
  it('attaches Bearer + content-type, returns parsed JSON', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push([url, init]);
      // First call: token mint. Second: actual request.
      if (calls.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ access_token: 'tok-Z', expires_in: 3600 }),
          text: () => Promise.resolve(''),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'eligible' }),
        text: () => Promise.resolve(''),
      } as Response);
    }) as unknown as typeof globalThis.fetch;
    const c = new AvailityClient(CREDS, { fetchImpl, nowMs: () => 1 });
    const r = await c.request<{ result: string }>({
      path: '/v1/eligibility-and-benefits',
      method: 'POST',
      body: { memberId: 'X' },
    });
    expect(r.result).toBe('eligible');
    const headers = (calls[1][1].headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-Z');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('rejects when constructor gets empty creds', () => {
    expect(() => new AvailityClient({ clientId: '', clientSecret: '' })).toThrow();
  });
});
