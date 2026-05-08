import { ApiError, api } from '../client';
import { authStore } from '../../auth/auth-store';

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authStore.clear();
  });

  it('attaches Authorization when a token is present', async () => {
    authStore.set({ token: 't', orgId: 'o', userId: 'u', role: 'admin' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await api<{ ok: boolean }>('/v1/x');
    expect(r.ok).toBe(true);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t');
  });

  it('throws ApiError with code on non-2xx JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'BAD', message: 'no good' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    let err: ApiError | null = null;
    try {
      await api('/v1/x', { on401: 'throw' });
    } catch (e) {
      err = e as ApiError;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.status).toBe(400);
    expect(err!.code).toBe('BAD');
  });

  it('builds query strings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await api('/v1/x', { method: 'GET', query: { a: '1', b: 2, c: undefined } });
    const url = (fetchMock.mock.calls[0][0] as string);
    expect(url).toContain('/v1/x?');
    expect(url).toContain('a=1');
    expect(url).toContain('b=2');
    expect(url).not.toContain('c=');
  });

  it('returns undefined for 204', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r = await api('/v1/x');
    expect(r).toBeUndefined();
  });

  it('translates a devheader.* token into X-Org-Id / X-User-Id / X-Role headers (NOT Bearer)', async () => {
    authStore.set({
      token: 'devheader.org.user.admin',
      orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await api('/v1/x');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Org-Id']).toBe('11111111-1111-4111-8111-111111111111');
    expect(headers['X-User-Id']).toBe('22222222-2222-4222-8222-222222222222');
    expect(headers['X-Role']).toBe('admin');
  });

  it('passes a real JWT through Authorization: Bearer (no devheader prefix)', async () => {
    authStore.set({
      token: 'eyJhbGciOiJSUzI1NiJ9.realjwt.signature',
      orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await api('/v1/x');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer eyJhbGciOiJSUzI1NiJ9.realjwt.signature');
    expect(headers['X-Org-Id']).toBeUndefined();
  });
});
