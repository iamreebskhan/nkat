/**
 * CMS-0057-F Prior Authorization API adapter.
 *
 * The CMS Interoperability and Prior Authorization Final Rule (CMS-0057-F),
 * effective Jan 1, 2027, requires impacted payers (MA, Medicaid FFS+managed,
 * CHIP, QHPs on FFEs) to expose 4 FHIR R4 APIs. The Prior Authorization API
 * supports:
 *   1. checking if PA is required for a service
 *   2. surfacing documentation needs (LOINC / required-doc codes)
 *   3. electronic submission
 *   4. electronic decisions
 *
 * This adapter:
 *   - issues a PA-required check via FHIR (GET CoverageEligibilityResponse)
 *   - parses the response into a typed shape
 *   - persists to `cms_0057_pa_response` for audit + replay
 *   - normalises the result into a payer_rule-shaped value object so the
 *     analyst extraction queue can promote it to authoritative
 *
 * The fetch implementation is injected so tests can stub network without
 * pulling in nock or msw.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runWithTenant } from '../database/rls-transaction';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckPaInput {
  org_id: string;
  payer_id: string;
  fhir_base_url: string;
  bearer_token: string;
  payer_member_id: string; // de-identified upstream
  service_codes: string[]; // CPT/HCPCS
  date_of_service: Date;
  request_correlation_id: string;
}

export type PaDecision = 'approved' | 'denied' | 'pending' | 'unknown';

export interface PaResult {
  pa_required: boolean | null;
  decision: PaDecision;
  documentation_codes: string[]; // LOINC codes from the response
  raw_status: number;
  raw_body: Record<string, unknown>;
  cached_response_id: string;
}

interface FhirCoverageEligibilityResponse {
  resourceType?: string;
  status?: string;
  outcome?: string; // 'complete' | 'queued' | 'error' | 'partial'
  // FHIR R4 CoverageEligibilityResponse.insurance.item — slim shape:
  insurance?: Array<{
    item?: Array<{
      productOrService?: { coding?: Array<{ system?: string; code?: string }> };
      authorizationRequired?: boolean;
      authorizationSupporting?: Array<{ coding?: Array<{ system?: string; code?: string }> }>;
      // Custom extension some payers use to carry the decision string.
      extension?: Array<{ url?: string; valueString?: string; valueBoolean?: boolean }>;
    }>;
  }>;
}

const PA_DECISION_EXT_URL =
  'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-decision';

export class Cms0057PaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'Cms0057PaError';
  }
}

@Injectable()
export class Cms0057PaAdapter {
  private readonly fetchImpl: FetchLike;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Optional() fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async checkPa(input: CheckPaInput): Promise<PaResult> {
    const url = this.buildUrl(input);
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/fhir+json',
        Authorization: `Bearer ${input.bearer_token}`,
      },
    });
    const status = res.status;
    const body = await res.text();
    if (!res.ok) throw new Cms0057PaError(`PA check failed: HTTP ${status}`, status, body);

    let parsed: FhirCoverageEligibilityResponse;
    try {
      parsed = JSON.parse(body) as FhirCoverageEligibilityResponse;
    } catch {
      throw new Cms0057PaError('Invalid JSON in PA response', status, body);
    }

    const result = decodePaResponse(parsed, input.service_codes);

    const cached = await runWithTenant(this.db, input.org_id, async (tx) => {
      const inserted = await tx
        .insertInto('cms_0057_pa_response')
        .values({
          org_id: input.org_id,
          payer_id: input.payer_id,
          request_correlation_id: input.request_correlation_id,
          fhir_request_uri: url,
          fhir_response_status: status,
          fhir_response_body: sql`${JSON.stringify(parsed)}::jsonb`,
          pa_required: result.pa_required,
          decision: result.decision,
          documentation_codes: result.documentation_codes,
          patient_external_id: input.payer_member_id,
          service_codes: input.service_codes,
          date_of_service: input.date_of_service,
          resulting_candidate_id: null,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      return inserted.id;
    });

    return {
      ...result,
      raw_status: status,
      raw_body: parsed as Record<string, unknown>,
      cached_response_id: cached,
    };
  }

  private buildUrl(input: CheckPaInput): string {
    const dos = input.date_of_service.toISOString().slice(0, 10);
    const codes = encodeURIComponent(input.service_codes.join(','));
    const member = encodeURIComponent(input.payer_member_id);
    const base = input.fhir_base_url.replace(/\/$/, '');
    return `${base}/CoverageEligibilityResponse?member=${member}&service-codes=${codes}&dos=${dos}`;
  }
}

/**
 * Pure-function decoder. Exported for direct unit testing without HTTP /  DB.
 */
export function decodePaResponse(
  fhir: FhirCoverageEligibilityResponse,
  requestedCodes: string[],
): { pa_required: boolean | null; decision: PaDecision; documentation_codes: string[] } {
  const requested = new Set(requestedCodes);
  let paRequired: boolean | null = null;
  let decision: PaDecision = 'unknown';
  const docCodes: string[] = [];

  if (fhir.outcome === 'queued' || fhir.outcome === 'partial') decision = 'pending';
  if (fhir.outcome === 'error') decision = 'unknown';

  for (const ins of fhir.insurance ?? []) {
    for (const item of ins.item ?? []) {
      const itemCodes = (item.productOrService?.coding ?? [])
        .map((c) => c.code)
        .filter((c): c is string => typeof c === 'string');
      if (requestedCodes.length > 0 && !itemCodes.some((c) => requested.has(c))) continue;

      if (typeof item.authorizationRequired === 'boolean') {
        // Most-restrictive wins: if ANY matching item requires PA, paRequired=true.
        paRequired = paRequired === true || item.authorizationRequired;
      }
      for (const supporting of item.authorizationSupporting ?? []) {
        for (const coding of supporting.coding ?? []) {
          if (coding.code) docCodes.push(coding.code);
        }
      }
      // Decoded decision via a Da Vinci PAS-shaped extension, if present.
      for (const ext of item.extension ?? []) {
        if (ext.url === PA_DECISION_EXT_URL && typeof ext.valueString === 'string') {
          const v = ext.valueString.toLowerCase();
          if (v === 'approved' || v === 'denied' || v === 'pending') decision = v;
        }
      }
    }
  }

  // If we know PA-required but no explicit decision came through, we leave decision='unknown'.
  return {
    pa_required: paRequired,
    decision,
    documentation_codes: Array.from(new Set(docCodes)).sort(),
  };
}
