import { ApiClient, ApiClientError } from '../lib/api-client';

const ORG = '11111111-1111-4111-8111-111111111111';

/**
 * jsdom doesn't expose the Web Fetch `Response` constructor. We return a
 * structural duck-type with the surface our ApiClient actually uses
 * (.ok, .status, .json(), .text()).
 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

describe('ApiClient.lookup', () => {
  it('POSTs to /v1/lookup with X-Org-Id header and JSON body', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const entry: { url: string; init?: RequestInit } = { url };
      if (init !== undefined) entry.init = init;
      seen.push(entry);
      return jsonResponse(200, {
        request_id: 'r1',
        date_of_service: '2026-04-15',
        lines: [],
        cross_line_findings: [],
        overall_severity: 'ok',
        summary: 'ok',
      });
    };
    const client = new ApiClient({ baseUrl: 'http://api.test', orgId: ORG, fetchImpl });

    const r = await client.lookup({
      payer_id: 'p',
      state: 'OH',
      product_line: 'medicare_ffs',
      date_of_service: '2026-04-15',
      lines: [{ code: '99497' }],
    });

    expect(r.overall_severity).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://api.test/v1/lookup');
    const headers = (seen[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Org-Id']).toBe(ORG);
    expect(headers['Content-Type']).toBe('application/json');
    expect(seen[0].init?.method).toBe('POST');
  });

  it('strips trailing slash from baseUrl', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seen.push(url);
      return jsonResponse(200, {
        request_id: 'r',
        date_of_service: '2026-04-15',
        lines: [],
        cross_line_findings: [],
        overall_severity: 'ok',
        summary: '',
      });
    };
    const client = new ApiClient({ baseUrl: 'http://api.test/', orgId: ORG, fetchImpl });
    await client.lookup({
      payer_id: 'p', state: 'OH', product_line: 'medicare_ffs',
      date_of_service: '2026-04-15', lines: [],
    });
    expect(seen[0]).toBe('http://api.test/v1/lookup');
  });

  it('throws ApiClientError on non-2xx', async () => {
    const fetchImpl = async (): Promise<Response> => textResponse(500, 'boom');
    const client = new ApiClient({ baseUrl: 'http://api.test', orgId: ORG, fetchImpl });
    await expect(
      client.lookup({
        payer_id: 'p', state: 'OH', product_line: 'medicare_ffs',
        date_of_service: '2026-04-15', lines: [],
      }),
    ).rejects.toMatchObject({ name: 'ApiClientError', status: 500, body: 'boom' });
    expect(new ApiClientError('m', 500, 'b')).toBeInstanceOf(Error);
  });

  it('passes X-User-Id when supplied', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init) seen.push(init);
      return jsonResponse(200, {
        request_id: 'r', date_of_service: 'd', lines: [], cross_line_findings: [],
        overall_severity: 'ok', summary: '',
      });
    };
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      orgId: ORG,
      userId: '22222222-2222-4222-8222-222222222222',
      fetchImpl,
    });
    await client.lookup({
      payer_id: 'p', state: 'OH', product_line: 'medicare_ffs',
      date_of_service: '2026-04-15', lines: [],
    });
    const headers = seen[0].headers as Record<string, string>;
    expect(headers['X-User-Id']).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('omits X-User-Id when not supplied', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init) seen.push(init);
      return jsonResponse(200, {
        request_id: 'r', date_of_service: 'd', lines: [], cross_line_findings: [],
        overall_severity: 'ok', summary: '',
      });
    };
    const client = new ApiClient({ baseUrl: 'http://api.test', orgId: ORG, fetchImpl });
    await client.lookup({
      payer_id: 'p', state: 'OH', product_line: 'medicare_ffs',
      date_of_service: '2026-04-15', lines: [],
    });
    const headers = seen[0].headers as Record<string, string>;
    expect(headers['X-User-Id']).toBeUndefined();
  });
});
