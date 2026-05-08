/**
 * api-client — minimal browser-friendly client for the backend's /v1/lookup
 * endpoint. Re-uses the request/response shape declared in
 * backend/src/lookup/dto, but defines its own copy so the extension stays
 * decoupled from the NestJS DTO classes (which use class-validator decorators
 * not available in the browser bundle).
 */

export interface ClaimLine {
  code: string;
  modifiers?: string[];
  pos?: string;
  units?: number;
}

export interface LookupRequest {
  payer_id: string;
  state: string;
  product_line: string;
  date_of_service: string;
  lines: ClaimLine[];
  diagnoses?: string[];
  provider_taxonomy?: string;
  cob_other_coverage?: string;
  client_id?: string;
  patient_external_id?: string;
}

export interface Citation {
  source_doc_id: string;
  source_url: string;
  retrieved_at: string;
  effective_date?: string;
  expiration_date?: string;
  verbatim_quote?: string;
  page_number?: number;
}

export type Severity = 'critical' | 'warning' | 'info' | 'ok';

export interface Finding {
  severity: Severity;
  carc_class: string;
  title: string;
  detail: string;
  confidence: number;
  citations: Citation[];
  recommendation?: string;
  applies_to_line_index?: number;
}

export interface LineFindings {
  line_index: number;
  code: string;
  findings: Finding[];
}

export interface LookupResponse {
  request_id: string;
  date_of_service: string;
  lines: LineFindings[];
  cross_line_findings: Finding[];
  overall_severity: Severity;
  summary: string;
}

export interface ApiClientConfig {
  baseUrl: string;
  orgId: string;
  userId?: string;
  /** Override fetch for tests. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export class ApiClient {
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly cfg: ApiClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async lookup(req: LookupRequest): Promise<LookupResponse> {
    const url = this.cfg.baseUrl.replace(/\/$/, '') + '/v1/lookup';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Org-Id': this.cfg.orgId,
    };
    if (this.cfg.userId) headers['X-User-Id'] = this.cfg.userId;

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiClientError(`POST /v1/lookup → ${res.status}`, res.status, body);
    }
    return (await res.json()) as LookupResponse;
  }
}
