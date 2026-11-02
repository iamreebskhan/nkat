/**
 * The two real-time questions (0120): is this patient covered (270/271), and
 * where is this claim (276/277). Asked over the connection's real-time
 * channel — CAQH CORE (X12 in a SOAP envelope) or Availity's REST API.
 *
 * ELIGIBILITY is recorded where the chart already keeps coverage checks
 * (insurance_verification, 0111) as method "clearinghouse", with the payer's
 * answer summarised in `details`: coverage, plan, dates, what the patient
 * pays, and a hospice election when the payer reports one.
 *
 * CLAIM STATUS is recorded on the claim's history and its latest file's row.
 * It never moves a claim: a "finalized: paid" status is not a payment until
 * the 835 says how much and why.
 *
 * Both are disclosures of the patient's data to the payer, logged as exports.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { readBillingProvider } from "@/lib/features/billing/billing-provider.service";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";
import { applyPhiKeyIfConfigured } from "@/lib/hipaa/pgp";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import { envelopeFor } from "./claim-file.service";
import { loadConnection, type LoadedConnection } from "./connection.service";
import { availityClaimStatus, availityCoverage } from "./transport/availity-api";
import { coreRealTime } from "./transport/core-soap";
import { VENDOR_PROFILES, type ClearinghouseVendor } from "./vendors";
import { buildClaimStatus276, buildEligibility270, traceOriginator } from "./x12/x12-270-276";
import { hospiceElectionText, parse271, verificationResult, type EligibilitySummary } from "./x12/x12-271";
import { claimState277, isRejection, parse277, type ClaimState277, type ClaimStatus277 } from "./x12/x12-277";
import { describeStatus, ELIGIBILITY_ERRORS, INSURANCE_TYPES } from "./x12/x12-codes";
import { wrapInterchange } from "./x12/x12-write";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** The connection to ask through: the one named, else the primary with a real-time channel, else any. */
async function realtimeConnection(tx: Tx, orgId: string, connectionId: string | null | undefined): Promise<LoadedConnection> {
  let id = connectionId ?? null;
  if (!id) {
    const r = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM clearinghouse_connection
       WHERE org_id = ${orgId}::uuid AND status = 'active' AND realtime_channel <> 'none'
       ORDER BY is_primary DESC, created_at LIMIT 1
    `;
    id = r[0]?.id ?? null;
  }
  if (!id) {
    throw new ValidationError("Real-time checks aren't set up yet. An admin can add a clearinghouse with CAQH CORE or Availity's API in Settings → Integrations.");
  }
  const c = await loadConnection(tx, orgId, id);
  if (c.status !== "active") throw new ValidationError(`The "${c.label}" connection is switched off. Pick another, or an admin can switch it on in Settings → Integrations.`);
  if (c.realtimeChannel === "none") {
    throw new ValidationError(`The "${c.label}" connection isn't set up for real-time checks. Pick another, or an admin can add CAQH CORE or Availity's API to it.`);
  }
  return c;
}

async function payerIdOf(tx: Tx, orgId: string, connectionId: string, payerId: string, vendorName: string, payerName: string): Promise<string> {
  const r = await tx.$queryRaw<{ external_payer_id: string }[]>`
    SELECT external_payer_id FROM clearinghouse_payer_id
     WHERE org_id = ${orgId}::uuid AND connection_id = ${connectionId}::uuid AND payer_id = ${payerId}::uuid
  `;
  if (!r[0]) throw new ValidationError(`${vendorName} needs its ID for ${payerName} first. An admin can add it in Settings → Integrations → Payer IDs.`);
  return r[0].external_payer_id;
}

const sexOf = (s: string | null) => (s === "F" || s === "M" ? s : s ? "U" : null);

/** One line for the coverage check's notes: what the payer said, in words. */
export function eligibilityNote(s: EligibilitySummary): string {
  if (s.coverage === "unknown" && s.errors.length > 0) {
    return s.errors.map((e) => ELIGIBILITY_ERRORS[e.code] ?? `Payer error ${e.code}`).join("; ");
  }
  // The payer's plan name, then the kind of plan when it adds something
  // ("MEDICARE PART B" and "Medicare Part B" are said once).
  const kind = s.insuranceType ? INSURANCE_TYPES[s.insuranceType] ?? s.insuranceType : null;
  const plan = [s.planDescription, kind && kind.toLowerCase() !== s.planDescription?.toLowerCase() ? kind : null].filter(Boolean).join(" · ");
  const hospice = s.hospice.length > 0 ? ` · hospice election on file ${s.hospice.map(hospiceElectionText).join("; ")}` : "";
  const other = s.otherPayers.length > 0 ? ` · other payer: ${s.otherPayers.map((o) => o.name ?? o.insuranceType).join(", ")}` : "";
  return `${s.coverage === "active" ? "Active coverage" : s.coverage === "inactive" ? "Not covered" : "Coverage not stated"}${plan ? `: ${plan}` : ""}${hospice}${other}`.slice(0, 1000);
}

/**
 * Whether an eligibility check can be asked, and through which connection —
 * for the chart's "Check eligibility now", whose viewers (intake, clinicians)
 * do not read the billing screens' connection list. Names only.
 */
export async function eligibilityAvailability(args: { orgId: string }): Promise<{ available: boolean; vendorName: string | null; label: string | null }> {
  return withOrgContext(args.orgId, async (tx) => {
    const r = await tx.$queryRaw<{ vendor: ClearinghouseVendor; label: string }[]>`
      SELECT vendor, label FROM clearinghouse_connection
       WHERE org_id = ${args.orgId}::uuid AND status = 'active' AND realtime_channel <> 'none'
       ORDER BY is_primary DESC, created_at LIMIT 1
    `;
    return r[0]
      ? { available: true, vendorName: VENDOR_PROFILES[r[0].vendor].name, label: r[0].label }
      : { available: false, vendorName: null, label: null };
  });
}

export interface EligibilityResult {
  verificationId: string;
  result: "active" | "inactive" | "not_found" | "pending";
  note: string;
  summary: EligibilitySummary;
  vendorName: string;
}

export async function checkEligibility(args: { orgId: string; userId: string; patientId: string; connectionId?: string | null; now?: Date }): Promise<EligibilityResult> {
  const now = args.now ?? new Date();
  const prep = await withOrgContext(args.orgId, async (tx) => {
    const conn = await realtimeConnection(tx, args.orgId, args.connectionId);
    const p = await tx.$queryRaw<{
      first_name: string; last_name: string; dob: string | null; sex: string | null; payer_id: string | null;
      member_id: string | null; payer_name: string | null;
    }[]>`
      SELECT p.first_name, p.last_name, to_char(p.date_of_birth, 'YYYY-MM-DD') AS dob, p.sex_assigned_at_birth AS sex,
             p.primary_payer_id AS payer_id, p.primary_member_id AS member_id, pay.name::text AS payer_name
        FROM patient p LEFT JOIN payer pay ON pay.id = p.primary_payer_id
       WHERE p.org_id = ${args.orgId}::uuid AND p.id = ${args.patientId}::uuid
    `;
    const pt = p[0];
    if (!pt) throw new NotFoundError("Patient not found.");
    if (!pt.payer_id || !pt.payer_name) throw new ValidationError("There's no insurance on the chart to check. Add it under Insurance first.");
    if (!pt.member_id?.trim()) throw new ValidationError("There's no member ID on the chart. Add it under Insurance first.");
    if (!pt.dob) throw new ValidationError("Add the patient's date of birth to the chart (Identity) first: payers find a member by it.");
    const externalPayerId = await payerIdOf(tx, args.orgId, conn.id, pt.payer_id, conn.vendorName, pt.payer_name);
    const billing = await readBillingProvider(tx, args.orgId);
    if (!billing.npi || !billing.legalName) throw new ValidationError("The practice's billing name and NPI are needed to ask (Settings → Billing provider).");
    const n = await tx.$queryRaw<{ icn: bigint; gcn: bigint }[]>`
      SELECT nextval('x12_interchange_control_seq') AS icn, nextval('x12_group_control_seq') AS gcn
    `;
    return {
      conn, pt, externalPayerId, billing,
      icn: Number(n[0]!.icn), gcn: Number(n[0]!.gcn),
      asOf: orgToday(await readOrgTimeZone(tx, args.orgId), now),
    };
  });
  const { conn, pt, billing } = prep;
  const trace = `PE${prep.gcn}`;

  let summary: EligibilitySummary;
  if (conn.realtimeChannel === "core_soap") {
    const core = conn.settings.core!;
    const set = buildEligibility270({
      controlNumber: "0001", reference: trace, now,
      payer: { name: pt.payer_name!, id: prep.externalPayerId },
      provider: { name: billing.legalName!, npi: billing.npi! },
      patient: { lastName: pt.last_name, firstName: pt.first_name, memberId: pt.member_id!, dob: pt.dob!, sex: sexOf(pt.sex) },
      traceNumber: trace, traceOriginator: traceOriginator(billing.ein, billing.npi!),
      serviceTypes: [conn.settings.eligibilityServiceType || "30"], asOf: prep.asOf,
    });
    const payload = wrapInterchange(envelopeFor(conn, { icn: prep.icn, gcn: prep.gcn }, "HS", "005010X279A1", now), [set]);
    const res = await coreRealTime({
      url: core.url, username: core.username, password: conn.secrets.corePassword ?? "",
      senderId: core.senderId, receiverId: core.receiverId, payloadType: "X12_270_Request_005010X279A1", payload,
    });
    if (!res.payload) throw new ValidationError(`${conn.vendorName} returned no 271${res.errorMessage ? `: ${res.errorMessage.slice(0, 200)}` : "."}`);
    summary = parse271(res.payload);
  } else {
    const api = conn.settings.availityApi!;
    summary = await availityCoverage(
      { ...api, clientSecret: conn.secrets.apiClientSecret ?? "" },
      `${conn.id}:${api.clientId}`,
      {
        payerId: prep.externalPayerId, providerNpi: billing.npi!, memberId: pt.member_id!, lastName: pt.last_name,
        firstName: pt.first_name, dob: pt.dob!, serviceType: conn.settings.eligibilityServiceType || "30", asOf: prep.asOf,
      },
    );
  }

  const result = verificationResult(summary);
  const note = eligibilityNote(summary);
  const verificationId = await withOrgContext(args.orgId, async (tx) => {
    const phi = await applyPhiKeyIfConfigured(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO insurance_verification (
        org_id, patient_id, payer_id, member_id, member_id_enc, method, result,
        coverage_effective_on, coverage_ends_on, reference, notes, verified_by_user_id, details, connection_id
      ) VALUES (
        ${args.orgId}::uuid, ${args.patientId}::uuid, ${pt.payer_id}::uuid, ${pt.member_id},
        CASE WHEN ${phi} THEN encrypt_phi(${pt.member_id}) ELSE NULL END,
        'clearinghouse', ${result},
        ${summary.eligibilityBegin ?? summary.planBegin}::date,
        ${(() => {
          const end = summary.eligibilityEnd ?? summary.planEnd;
          const begin = summary.eligibilityBegin ?? summary.planBegin;
          return end && begin && end < begin ? null : end;
        })()}::date,
        ${trace}, ${note}, ${args.userId}::uuid, ${JSON.stringify(summary)}::jsonb, ${conn.id}::uuid
      )
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "insurance_verification",
      targetType: "patient",
      targetId: args.patientId,
      payload: { subject: "patient", method: "clearinghouse", result, vendor: conn.vendor, channel: conn.realtimeChannel },
    });
    return rows[0]!.id;
  });
  void logPhiExport({ orgId: args.orgId, userId: args.userId, exportType: "eligibility_270", patientIds: [args.patientId] });
  return { verificationId, result, note, summary, vendorName: conn.vendorName };
}

export interface ClaimStatusResult {
  state: ClaimState277 | null;
  statuses: (ClaimStatus277 & { text: string })[];
  payerClaimNumber: string | null;
  vendorName: string;
}

export async function checkClaimStatus(args: { orgId: string; userId: string; superbillId: string; connectionId?: string | null; now?: Date }): Promise<ClaimStatusResult> {
  const now = args.now ?? new Date();
  const prep = await withOrgContext(args.orgId, async (tx) => {
    const conn = await realtimeConnection(tx, args.orgId, args.connectionId);
    const r = await tx.$queryRaw<{
      id: string; status: string; visit_id: string | null; patient_id: string; dos: string; billed: bigint | number;
      member_id: string | null; payer_id: string | null; payer_name: string | null; provider_npi: string | null;
      first_name: string; last_name: string; dob: string | null; sex: string | null; pcn: string | null;
    }[]>`
      SELECT s.id, s.status, s.visit_id, s.patient_id, to_char(s.date_of_service, 'YYYY-MM-DD') AS dos,
             s.billed_amount_cents AS billed, s.member_id_snapshot AS member_id, s.payer_id, pay.name::text AS payer_name,
             s.provider_npi, p.first_name, p.last_name, to_char(p.date_of_birth, 'YYYY-MM-DD') AS dob,
             p.sex_assigned_at_birth AS sex,
             COALESCE(
               (SELECT e.payer_claim_control_number FROM era_835_record e
                 WHERE e.superbill_id = s.id AND e.payer_claim_control_number IS NOT NULL ORDER BY e.ingested_at DESC LIMIT 1),
               (SELECT i.payer_claim_number FROM claim_submission_item i
                 WHERE i.superbill_id = s.id AND i.payer_claim_number IS NOT NULL ORDER BY i.updated_at DESC LIMIT 1)
             ) AS pcn
        FROM superbill s
        JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
        LEFT JOIN payer pay ON pay.id = s.payer_id
       WHERE s.org_id = ${args.orgId}::uuid AND s.id = ${args.superbillId}::uuid
    `;
    const c = r[0];
    if (!c) throw new NotFoundError("Claim not found.");
    if (c.status === "draft" || c.status === "ready_to_submit" || c.status === "voided") {
      throw new ValidationError("A claim's status can be checked once it's been submitted.");
    }
    if (!c.payer_id || !c.payer_name) throw new ValidationError("This claim has no payer. Add the insurance on the patient's chart, then update the bill from the chart.");
    if (!c.member_id || !c.dob) throw new ValidationError("This claim has no member ID, or the patient has no date of birth. Fix the chart, then try again.");
    const externalPayerId = await payerIdOf(tx, args.orgId, conn.id, c.payer_id, conn.vendorName, c.payer_name);
    const billing = await readBillingProvider(tx, args.orgId);
    if (!billing.npi || !billing.legalName) throw new ValidationError("The practice's billing name and NPI are needed to ask (Settings → Billing provider).");
    const n = await tx.$queryRaw<{ icn: bigint; gcn: bigint }[]>`
      SELECT nextval('x12_interchange_control_seq') AS icn, nextval('x12_group_control_seq') AS gcn
    `;
    return { conn, c, externalPayerId, billing, icn: Number(n[0]!.icn), gcn: Number(n[0]!.gcn) };
  });
  const { conn, c, billing } = prep;
  const claimRef = claimRefFor(c.id);
  const trace = `PS${prep.gcn}`;

  let statuses: ClaimStatus277[] = [];
  let payerClaimNumber: string | null = c.pcn;
  if (conn.realtimeChannel === "core_soap") {
    const core = conn.settings.core!;
    const set = buildClaimStatus276({
      controlNumber: "0001", reference: trace, now,
      payer: { name: c.payer_name!, id: prep.externalPayerId },
      submitter: { name: conn.settings.submitter.name, id: conn.settings.submitter.id },
      provider: { name: billing.legalName!, npi: billing.npi! },
      patient: { lastName: c.last_name, firstName: c.first_name, memberId: c.member_id!, dob: c.dob!, sex: sexOf(c.sex) },
      claim: { traceNumber: trace, claimRef, payerClaimNumber: c.pcn, totalChargeCents: Number(c.billed), dateOfService: c.dos },
    });
    const payload = wrapInterchange(envelopeFor(conn, { icn: prep.icn, gcn: prep.gcn }, "HR", "005010X212", now), [set]);
    const res = await coreRealTime({
      url: core.url, username: core.username, password: conn.secrets.corePassword ?? "",
      senderId: core.senderId, receiverId: core.receiverId, payloadType: "X12_276_Request_005010X212", payload,
    });
    if (!res.payload) throw new ValidationError(`${conn.vendorName} returned no 277${res.errorMessage ? `: ${res.errorMessage.slice(0, 200)}` : "."}`);
    const doc = parse277(res.payload);
    const hit = doc.claims.find((x) => x.patientControlNumber.toUpperCase() === claimRef || x.patientAccountNumber?.toUpperCase() === claimRef) ?? doc.claims[0];
    statuses = hit?.statuses ?? doc.batchStatuses;
    payerClaimNumber = hit?.payerClaimNumber ?? payerClaimNumber;
  } else {
    const api = conn.settings.availityApi!;
    const r = await availityClaimStatus(
      { ...api, clientSecret: conn.secrets.apiClientSecret ?? "" },
      `${conn.id}:${api.clientId}`,
      {
        payerId: prep.externalPayerId, providerNpi: billing.npi!, memberId: c.member_id!, lastName: c.last_name,
        firstName: c.first_name, dob: c.dob!, fromDate: c.dos, toDate: c.dos, claimAmountCents: Number(c.billed),
        claimRef, payerClaimNumber: c.pcn,
      },
    );
    const hit = r.claims.find((x) => x.patientControlNumber.toUpperCase() === claimRef) ?? r.claims[0];
    statuses = hit?.statuses ?? [];
    payerClaimNumber = hit?.payerClaimNumber ?? payerClaimNumber;
  }

  const state = claimState277(statuses);
  const described = statuses.map((s) => ({ ...s, text: describeStatus(s) }));
  const first = statuses.find(isRejection) ?? statuses[0];
  await withOrgContext(args.orgId, async (tx) => {
    // The claim's latest file keeps the answer, when Pallio built one.
    await tx.$executeRaw`
      UPDATE claim_submission_item i SET
        payer_state = COALESCE(${state}, i.payer_state),
        payer_statuses = CASE WHEN ${statuses.length > 0} THEN ${JSON.stringify(statuses.map((s) => ({ ...s, source: "payer" })))}::jsonb ELSE i.payer_statuses END,
        payer_claim_number = COALESCE(${payerClaimNumber}, i.payer_claim_number),
        payer_at = now(), updated_at = now()
       WHERE i.org_id = ${args.orgId}::uuid AND i.superbill_id = ${c.id}::uuid
         AND i.submission_id = (
           SELECT j.submission_id FROM claim_submission_item j JOIN claim_submission s ON s.id = j.submission_id
            WHERE j.superbill_id = ${c.id}::uuid ORDER BY s.created_at DESC LIMIT 1)
    `;
    await tx.$executeRaw`
      INSERT INTO superbill_activity (org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail, at)
      VALUES (${args.orgId}::uuid, ${c.id}::uuid, ${args.userId}::uuid, 'clearinghouse', ${c.status}, ${c.status},
              ${`Claim status from the payer, through ${conn.vendorName}: ${first ? describeStatus(first) : "no status returned"}${payerClaimNumber ? ` · payer claim # ${payerClaimNumber}` : ""}`.slice(0, 1000)},
              ${JSON.stringify({ event: "claim_status", state, channel: conn.realtimeChannel })}::jsonb, clock_timestamp())
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "claim_status_check", targetType: "superbill", targetId: c.id,
      payload: { state, vendor: conn.vendor, channel: conn.realtimeChannel, visitId: c.visit_id },
    });
  });
  void logPhiExport({ orgId: args.orgId, userId: args.userId, exportType: "claim_status_276", patientIds: [c.patient_id] });
  return { state, statuses: described, payerClaimNumber, vendorName: conn.vendorName };
}
