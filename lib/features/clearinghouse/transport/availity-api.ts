/**
 * Availity's REST APIs (0120), the second real-time channel Availity offers
 * beside CAQH CORE (developer.availity.com: Availity API Guide; HIPAA
 * Transaction APIs, Coverages 1.0.0 and Claim Statuses 1.0.0):
 *
 *   POST {base}/token            client_credentials, scope "hipaa"; the token
 *                                lasts five minutes and is reused until then
 *   POST {base}/coverages        form-encoded; answers with a coverage whose
 *                                statusCode is 0 (in progress) until the payer
 *                                answers, then 4 (complete), or an error code
 *   GET  {base}/coverages/{id}   polled while in progress
 *   GET  {base}/claim-statuses   query parameters; polled the same way
 *
 * Availity answers JSON, not X12, so this maps its fields onto the same
 * shapes the 271 and 277 readers produce (EligibilitySummary, ClaimStatus277).
 * The mapping follows Availity's published field names; anything it does not
 * recognise is left out rather than guessed, and the first test with the
 * practice's own credentials is where it gets confirmed.
 *
 * Server only. The client secret is sent to the token endpoint only, over TLS.
 */
import { ValidationError } from "@/lib/api";

import { assertPublicUrl } from "../endpoint-guard";
import { isHospiceElection, type EligibilityBenefit, type EligibilityError, type EligibilitySummary } from "../x12/x12-271";
import type { ClaimStatus277 } from "../x12/x12-277";
import { STATUS_CATEGORIES, STATUS_CODES } from "../x12/x12-codes";

export interface AvailityConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Demo plans: the canned scenario to answer with. */
  mockScenario?: string | null;
}

export class AvailityApiError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "AvailityApiError";
  }
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

const POLL_MS = 2_000;
const POLL_LIMIT_MS = 40_000;
const IN_PROGRESS = new Set(["0", "R1"]);

/** The payer answered: 4 complete, 3 complete with part of the answer invalid. */
const COMPLETE = new Set(["3", "4"]);

const COVERAGE_ERRORS: Record<string, string> = {
  "6": "The payer rejected the request",
  "7": "The payer did not respond",
  "13": "The payer's response was invalid",
  "14": "The payer did not respond",
  "15": "The payer is down for maintenance",
  "18": "Availity could not process the request",
  "19": "The payer found errors in the request",
};

async function call(cfg: AvailityConfig, path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const url = await assertPublicUrl(`${cfg.baseUrl.replace(/\/+$/, "")}${path}`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: "error" });
  } catch {
    throw new AvailityApiError(`${url.hostname} could not be reached.`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.status === 429) throw new AvailityApiError("Availity's rate limit was reached; try again in a minute.");
  return { status: res.status, body };
}

export async function availityToken(cfg: AvailityConfig, cacheKey: string): Promise<string> {
  const hit = tokens.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 15_000) return hit.token;
  const { status, body } = await call(cfg, "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: cfg.scope || "hipaa",
    }).toString(),
  });
  const b = (body ?? {}) as { access_token?: string; expires_in?: number };
  if (status === 401 || status === 400 || !b.access_token) {
    throw new AvailityApiError("Availity refused the client ID or secret (or the app is not subscribed to these APIs).");
  }
  tokens.set(cacheKey, { token: b.access_token, expiresAt: Date.now() + (Number(b.expires_in) || 300) * 1000 });
  return b.access_token;
}

function headers(cfg: AvailityConfig, token: string, form = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    ...(cfg.mockScenario ? { "X-Api-Mock-Scenario-ID": cfg.mockScenario } : {}),
  };
}

/**
 * A call with the reused token. Availity can end a token before its five
 * minutes are up, so a 401 drops it and the call is made once more with a new
 * one; a second 401, or a 403, is the credentials' or the subscription's.
 */
async function authorized(cfg: AvailityConfig, cacheKey: string, path: string, init: (token: string) => RequestInit): Promise<{ status: number; body: unknown }> {
  let r = await call(cfg, path, init(await availityToken(cfg, cacheKey)));
  if (r.status === 401) {
    tokens.delete(cacheKey);
    r = await call(cfg, path, init(await availityToken(cfg, cacheKey)));
  }
  if (r.status === 401) {
    throw new AvailityApiError("Availity didn't accept Pallio's sign-in. An admin can check the API client ID and secret with “Test connection” in Settings → Integrations, then try again.");
  }
  if (r.status === 403) {
    throw new AvailityApiError("Availity says this app isn't subscribed to this API. An admin can check the app's API subscriptions on Availity's developer portal.");
  }
  return r;
}

/** Wait out an answer still in progress, by its id. */
async function poll(cfg: AvailityConfig, cacheKey: string, path: string, first: Record<string, unknown>): Promise<Record<string, unknown>> {
  let cur = first;
  const started = Date.now();
  while (IN_PROGRESS.has(String(cur.statusCode ?? "")) && cur.id) {
    if (Date.now() - started > POLL_LIMIT_MS) {
      throw new AvailityApiError("The payer had not answered after 40 seconds. Availity keeps working on it; check again shortly.");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    const { status, body } = await authorized(cfg, cacheKey, `${path}/${encodeURIComponent(String(cur.id))}`, (token) => ({ method: "GET", headers: headers(cfg, token) }));
    if (status === 404) throw new AvailityApiError("Availity no longer has this request.");
    cur = (body ?? {}) as Record<string, unknown>;
  }
  return cur;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const day = (v: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v));
  return m ? m[1]! : null;
};
const centsOf = (v: unknown): number | null => {
  const n = Number(str(v).replace(/[$,]/g, ""));
  return str(v) !== "" && Number.isFinite(n) ? Math.round(n * 100) : null;
};
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

function validationErrors(c: Record<string, unknown>): EligibilityError[] {
  return arr(c.validationMessages).map((m) => ({
    level: "subscriber" as const,
    code: str(m.code) || str(m.errorCode) || "",
    followUp: "",
  }));
}

/** An Availity coverage as the EligibilitySummary a 271 reads into. */
export function coverageToSummary(c: Record<string, unknown>): EligibilitySummary {
  const plans = arr(c.plans);
  const benefits: EligibilityBenefit[] = [];
  for (const p of plans) {
    for (const b of arr(p.benefits)) {
      benefits.push({
        info: str(b.statusCode) || str(b.type),
        coverageLevel: str(b.coverageLevelCode),
        serviceTypes: [str(b.serviceTypeCode) || str(b.code)].filter(Boolean),
        insuranceType: str(p.insuranceTypeCode),
        description: str(b.name) || str(b.description),
        timePeriod: str(b.timePeriodQualifierCode),
        amountCents: centsOf(b.amount ?? (b.amounts as Record<string, unknown> | undefined)?.amount),
        percent: str(b.percent) ? Math.round(Number(str(b.percent)) * 10000) / 100 : null,
        inNetwork: str(b.inPlanNetworkIndicatorCode),
        from: day(b.startDate),
        to: day(b.endDate),
        messages: arr(b.messages).map((m) => str(m.message) || str(m)).filter(Boolean),
        entities: [],
      });
    }
  }
  const active = plans.some((p) => ["1", "2", "3", "4", "5"].includes(str(p.statusCode)) || /active/i.test(str(p.status)) && !/inactive/i.test(str(p.status)));
  const inactive = plans.some((p) => ["6", "7", "8"].includes(str(p.statusCode)) || /inactive/i.test(str(p.status)));
  const plan = plans[0] ?? {};
  return {
    payerName: str((c.payer as Record<string, unknown> | undefined)?.name) || null,
    coverage: active ? "active" : inactive ? "inactive" : "unknown",
    errors: validationErrors(c),
    planDescription: str(plan.description) || str(plan.groupName) || null,
    insuranceType: str(plan.insuranceTypeCode) || null,
    groupNumber: str(plan.groupNumber) || null,
    groupName: str(plan.groupName) || null,
    planBegin: day(plan.planStartDate) ?? day(plan.coverageStartDate),
    planEnd: day(plan.planEndDate) ?? day(plan.coverageEndDate),
    eligibilityBegin: day(plan.eligibilityStartDate),
    eligibilityEnd: day(plan.eligibilityEndDate),
    benefits,
    hospice: benefits.filter(isHospiceElection),
    otherPayers: [],
    messages: [],
  };
}

export async function availityCoverage(
  cfg: AvailityConfig,
  cacheKey: string,
  q: { payerId: string; providerNpi: string; memberId: string; lastName: string; firstName: string; dob: string; serviceType: string; asOf: string },
): Promise<EligibilitySummary> {
  const { status, body } = await authorized(cfg, cacheKey, "/coverages", (token) => ({
    method: "POST",
    headers: headers(cfg, token, true),
    body: new URLSearchParams({
      payerId: q.payerId,
      providerNpi: q.providerNpi,
      memberId: q.memberId,
      patientLastName: q.lastName,
      patientFirstName: q.firstName,
      patientBirthDate: q.dob,
      serviceType: q.serviceType,
      asOfDate: q.asOf,
      subscriberRelationship: "18",
    }).toString(),
  }));
  if (status === 400) {
    const errs = arr((body as Record<string, unknown> | null)?.errors).map((e) => str(e.errorMessage)).filter(Boolean);
    throw new AvailityApiError(`Availity refused the request${errs.length ? `: ${errs.join("; ").slice(0, 300)}` : "."}`);
  }
  if (status >= 500 || !body) throw new AvailityApiError(`Availity had a problem answering (HTTP ${status}). Try again in a few minutes.`);
  const done = await poll(cfg, cacheKey, "/coverages", body as Record<string, unknown>);
  const code = str(done.statusCode);
  if (!COMPLETE.has(code)) {
    throw new AvailityApiError(`${COVERAGE_ERRORS[code] ?? `Availity answered status ${code || "unknown"}`}${str(done.status) ? ` (${str(done.status)})` : ""}.`);
  }
  return coverageToSummary(done);
}

export interface AvailityClaimStatus {
  claims: { patientControlNumber: string; payerClaimNumber: string | null; statuses: ClaimStatus277[] }[];
}

export function claimStatusesToStatuses(r: Record<string, unknown>): AvailityClaimStatus {
  return {
    claims: arr(r.claimStatuses).map((c) => ({
      patientControlNumber: str(c.patientControlNumber),
      payerClaimNumber: str(c.claimControlNumber) || null,
      statuses: arr(c.statusDetails).map((d) => ({
        category: str(d.categoryCode),
        code: str(d.statusCode),
        entity: str(d.entityCode),
        effectiveDate: day(d.effectiveDate),
        action: "",
        chargeCents: centsOf(d.claimAmount),
        paidCents: centsOf(d.paymentAmount),
        adjudicatedDate: day(d.finalizedDate),
        paymentDate: day(d.remittanceDate),
        checkNumber: str(d.checkNumber),
        // Availity's own wording only where Pallio's code lists have no
        // words for the codes; otherwise the same thing would be said twice.
        message: STATUS_CATEGORIES[str(d.categoryCode)] && STATUS_CODES[str(d.statusCode)]
          ? ""
          : [str(d.category), str(d.status)].filter(Boolean).join(": "),
      })),
    })),
  };
}

export async function availityClaimStatus(
  cfg: AvailityConfig,
  cacheKey: string,
  q: {
    payerId: string; providerNpi: string; memberId: string; lastName: string; firstName: string; dob: string;
    fromDate: string; toDate: string; claimAmountCents: number; claimRef: string; payerClaimNumber?: string | null;
  },
): Promise<AvailityClaimStatus> {
  const params = new URLSearchParams({
    "payer.id": q.payerId,
    "providers.npi": q.providerNpi,
    "subscriber.memberId": q.memberId,
    "subscriber.lastName": q.lastName,
    "subscriber.firstName": q.firstName,
    "patient.lastName": q.lastName,
    "patient.firstName": q.firstName,
    "patient.birthDate": q.dob,
    "patient.subscriberRelationshipCode": "18",
    "patient.accountNumber": q.claimRef,
    fromDate: q.fromDate,
    toDate: q.toDate,
    claimAmount: (q.claimAmountCents / 100).toFixed(2),
    ...(q.payerClaimNumber ? { claimNumber: q.payerClaimNumber } : {}),
  });
  const { status, body } = await authorized(cfg, cacheKey, `/claim-statuses?${params.toString()}`, (token) => ({ method: "GET", headers: headers(cfg, token) }));
  if (status === 400) throw new AvailityApiError("Availity refused the claim status request.");
  if (status >= 500 || !body) throw new AvailityApiError(`Availity had a problem answering (HTTP ${status}). Try again in a few minutes.`);
  const done = await poll(cfg, cacheKey, "/claim-statuses", body as Record<string, unknown>);
  const code = str(done.statusCode);
  if (!COMPLETE.has(code)) {
    throw new AvailityApiError(`${COVERAGE_ERRORS[code] ?? `Availity answered status ${code || "unknown"}`}.`);
  }
  return claimStatusesToStatuses(done);
}

/** A test of the connection: a token, nothing else (no patient data leaves). */
export async function testAvailityApi(cfg: AvailityConfig, cacheKey: string): Promise<void> {
  tokens.delete(cacheKey);
  await availityToken(cfg, cacheKey);
}
