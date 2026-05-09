/**
 * CmsCoverageApiClient — typed thin wrapper around api.coverage.cms.gov.
 *
 *   GET /v1/metadata/license-agreement → returns license text + a token to
 *      include on data calls. We cache the token for the process lifetime.
 *   GET /v1/data/lcd?...                → list LCDs.
 *   GET /v1/data/lcd/{lcdId}            → LCD detail.
 *   GET /v1/data/article?...            → list LCD articles (incl. ICD-10 lists).
 *   GET /v1/data/article/{articleId}    → article detail.
 *   GET /v1/reports/national-coverage-ncd → list NCDs.
 *
 * The fetch implementation is injected so tests can stub network without
 * pulling in nock or msw.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CmsLcdSummary {
  lcd_id: string;
  title: string;
  contractor: string;
  effective_date: string; // ISO date
  retirement_date?: string;
}

export interface CmsLcdDetail extends CmsLcdSummary {
  url: string;
  body_html: string;
  cpt_codes: string[];
  hcpcs_codes: string[];
  icd10_covered: string[]; // ICD-10s on the medical-necessity list
  icd10_noncovered?: string[];
  documentation_requirements?: string[];
  utilization_guidelines?: string[];
}

export interface CmsArticleSummary {
  article_id: string;
  title: string;
  effective_date: string;
}

export interface CmsArticleDetail extends CmsArticleSummary {
  url: string;
  body_html: string;
  cpt_codes: string[];
  icd10_covered: string[];
  icd10_noncovered?: string[];
}

export interface CmsNcdSummary {
  ncd_id: string;
  title: string;
  effective_date: string;
}

export class CmsCoverageApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'CmsCoverageApiError';
  }
}

@Injectable()
export class CmsCoverageApiClient {
  private readonly log = new Logger(CmsCoverageApiClient.name);
  private licenseToken: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(@Inject(ENV_TOKEN) env: Env, @Optional() fetchImpl?: FetchLike) {
    this.baseUrl = env.CMS_COVERAGE_API_BASE_URL.replace(/\/$/, '');
    this.licenseToken = env.CMS_COVERAGE_API_TOKEN;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Visible for tests. */
  setLicenseToken(token: string | undefined): void {
    this.licenseToken = token;
  }

  /**
   * Acquire and cache the CMS license-agreement token. Returns the cached
   * token on subsequent calls.
   */
  async acquireLicenseToken(): Promise<string> {
    if (this.licenseToken) return this.licenseToken;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/metadata/license-agreement`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw await this.errorFor('GET /v1/metadata/license-agreement', res);
    const json = (await res.json()) as { token: string };
    this.licenseToken = json.token;
    return json.token;
  }

  async listLcds(
    params: { state?: string; cpt?: string; effectiveOn?: string } = {},
  ): Promise<CmsLcdSummary[]> {
    const url = new URL(`${this.baseUrl}/v1/data/lcd`);
    if (params.state) url.searchParams.set('state', params.state);
    if (params.cpt) url.searchParams.set('cpt', params.cpt);
    if (params.effectiveOn) url.searchParams.set('effective_on', params.effectiveOn);
    const json = await this.fetchJson<{ items: CmsLcdSummary[] }>(url.toString());
    return json.items ?? [];
  }

  async getLcd(lcdId: string): Promise<CmsLcdDetail> {
    return this.fetchJson<CmsLcdDetail>(`${this.baseUrl}/v1/data/lcd/${encodeURIComponent(lcdId)}`);
  }

  async listArticles(params: { lcdId?: string; cpt?: string } = {}): Promise<CmsArticleSummary[]> {
    const url = new URL(`${this.baseUrl}/v1/data/article`);
    if (params.lcdId) url.searchParams.set('lcd_id', params.lcdId);
    if (params.cpt) url.searchParams.set('cpt', params.cpt);
    const json = await this.fetchJson<{ items: CmsArticleSummary[] }>(url.toString());
    return json.items ?? [];
  }

  async getArticle(articleId: string): Promise<CmsArticleDetail> {
    return this.fetchJson<CmsArticleDetail>(
      `${this.baseUrl}/v1/data/article/${encodeURIComponent(articleId)}`,
    );
  }

  async listNcds(): Promise<CmsNcdSummary[]> {
    const json = await this.fetchJson<{ items: CmsNcdSummary[] }>(
      `${this.baseUrl}/v1/reports/national-coverage-ncd`,
    );
    return json.items ?? [];
  }

  // ----- internals -----

  private async fetchJson<T>(url: string): Promise<T> {
    const token = await this.acquireLicenseToken();
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-License-Token': token },
    });
    if (!res.ok) throw await this.errorFor(`GET ${url}`, res);
    return (await res.json()) as T;
  }

  private async errorFor(label: string, res: Response): Promise<CmsCoverageApiError> {
    const body = await res.text().catch(() => '');
    this.log.warn(`${label} → HTTP ${res.status}`);
    return new CmsCoverageApiError(`${label} failed (${res.status})`, res.status, body);
  }
}
