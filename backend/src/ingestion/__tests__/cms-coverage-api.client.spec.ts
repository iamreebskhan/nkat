import {
  CmsCoverageApiClient,
  CmsCoverageApiError,
  type FetchLike,
} from '../cms-coverage-api.client';
import type { Env } from '../../config/env';

const baseEnv = (overrides: Partial<Env> = {}): Env => ({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: 3000,
  PGHOST: 'h',
  PGPORT: 5432,
  PGDATABASE: 'd',
  PGUSER: 'u',
  PGPASSWORD: 'p',
  PGSSLMODE: 'disable',
  PG_POOL_MAX: 10,
  PG_STATEMENT_TIMEOUT_MS: 5000,
  CMS_COVERAGE_API_BASE_URL: 'https://api.coverage.cms.gov',
  BEDROCK_REGION: 'us-east-1',
  BEDROCK_MODEL_SYNTHESIS: 'm',
  BEDROCK_MODEL_PARSER: 'm',
  AUTH_MODE: 'dev_header',
  SESSION_TTL_SEC: 3600,
  ...overrides,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CmsCoverageApiClient', () => {
  it('acquires and caches the license token on first data call', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      if (String(url).endsWith('/v1/metadata/license-agreement')) {
        return jsonResponse(200, { token: 'TOK_ABC' });
      }
      return jsonResponse(200, {
        items: [
          { lcd_id: 'L33834', title: 'ACP', contractor: 'CGS', effective_date: '2024-01-01' },
        ],
      });
    };
    const c = new CmsCoverageApiClient(baseEnv(), fetchImpl);

    const r1 = await c.listLcds({ state: 'OH', cpt: '99497' });
    const r2 = await c.listLcds({ state: 'NC', cpt: '99497' });

    expect(r1).toEqual([expect.objectContaining({ lcd_id: 'L33834' })]);
    expect(r2).toHaveLength(1);
    expect(calls[0].url).toMatch(/license-agreement$/);
    expect(calls[1].url).toMatch(/lcd\?state=OH&cpt=99497/);
    expect(calls[2].url).toMatch(/lcd\?state=NC&cpt=99497/);
    expect((calls[1].init?.headers as Record<string, string>)['X-License-Token']).toBe('TOK_ABC');
    // license-agreement called only once
    expect(calls.filter((c) => c.url.endsWith('license-agreement')).length).toBe(1);
  });

  it('uses pre-supplied token from env without calling license-agreement', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(String(url));
      return jsonResponse(200, { items: [] });
    };
    const c = new CmsCoverageApiClient(baseEnv({ CMS_COVERAGE_API_TOKEN: 'PRE_TOKEN' }), fetchImpl);
    await c.listNcds();
    expect(calls).toEqual([expect.stringMatching(/national-coverage-ncd$/)]);
  });

  it('throws CmsCoverageApiError with status + body when CMS returns non-2xx', async () => {
    const fetchImpl: FetchLike = async () => new Response('rate limited', { status: 429 });
    const c = new CmsCoverageApiClient(baseEnv({ CMS_COVERAGE_API_TOKEN: 'TOK' }), fetchImpl);

    await expect(c.listLcds()).rejects.toMatchObject({
      name: 'CmsCoverageApiError',
      status: 429,
      body: 'rate limited',
    });
  });

  it('returns [] when CMS responds with no items field', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, {});
    const c = new CmsCoverageApiClient(baseEnv({ CMS_COVERAGE_API_TOKEN: 'TOK' }), fetchImpl);
    expect(await c.listLcds()).toEqual([]);
  });

  it('GETs LCD detail with URL-encoded id', async () => {
    let captured = '';
    const fetchImpl: FetchLike = async (url) => {
      captured = String(url);
      return jsonResponse(200, {
        lcd_id: 'L 33 / weird',
        title: 'X',
        contractor: 'CGS',
        effective_date: '2024-01-01',
        url: 'https://cms/lcd',
        body_html: '<p>...</p>',
        cpt_codes: ['99497'],
        hcpcs_codes: [],
        icd10_covered: ['Z51.5'],
      });
    };
    const c = new CmsCoverageApiClient(baseEnv({ CMS_COVERAGE_API_TOKEN: 'TOK' }), fetchImpl);
    const detail = await c.getLcd('L 33 / weird');
    expect(captured).toContain('/v1/data/lcd/L%2033%20%2F%20weird');
    expect(detail.cpt_codes).toEqual(['99497']);
  });

  it('CmsCoverageApiError preserves message and is instanceof Error', () => {
    const err = new CmsCoverageApiError('oops', 500, 'body');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
    expect(err.body).toBe('body');
  });
});
