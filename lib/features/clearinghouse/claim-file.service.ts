/**
 * 837P files (0120): built from reviewed claims, then either handed to the
 * person who asked (download: they upload it to the clearinghouse's portal
 * themselves) or sent by Pallio over the connection's SFTP channel.
 *
 * ONE FILE, ALL OR NOTHING. A claim with a stop (claim-837.ts) refuses the
 * whole file, naming every claim and why, so nothing half-goes.
 *
 * SENDING IS TWO STEPS, because an upload is too slow to hold row locks
 * through (Prisma's interactive transactions end at 5 s):
 *   1. one transaction locks the claims, runs every check a person's "Record
 *      as submitted" runs (the review's hard stops, the rendering NPI, the
 *      payer's documentation standard, with its override reason), builds the
 *      file and records it as sending — from then until the upload ends, the
 *      claims cannot be edited or moved (assertNotSending);
 *   2. the upload; then the file is recorded sent and each claim moves to
 *      submitted through markStatusTx (its own transaction, as the 835 posting
 *      does), or the file is recorded not sent and every claim says why.
 *
 * DOWNLOAD does not move a claim: the file has not reached anyone yet. The
 * 999 and 277CA the practice uploads back confirm it (inbound.service.ts).
 */
import { createHash } from "node:crypto";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { readBillingProvider, readClaimReferring } from "@/lib/features/billing/billing-provider.service";
import { EXPORTABLE_STATUSES } from "@/lib/features/billing/claim-export";
import { hardStopMessage, loadReviewChecks } from "@/lib/features/billing/claim-checks.service";
import type { CodeUnits } from "@/lib/features/billing/code-units";
import { readClaimAuthNumbers } from "@/lib/features/patients/prior-auth.service";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";
import { assertNotSending, markStatusTx } from "@/lib/features/superbills/superbill.service";
import { lineChargeCents, type SuperbillPricing } from "@/lib/features/superbills/superbill-pure";
import { documentationGap, documentationGapMessage, type DocumentationGap } from "@/lib/features/visits/documentation-check";
import { loadDocumentationGaps } from "@/lib/features/visits/documentation-check.service";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import { claimFileName, claimTo837, type ClaimSource, type PayerIdMapping } from "./claim-837";
import { loadConnection, type LoadedConnection } from "./connection.service";
import { openSftp } from "./transport/sftp";
import { buildClaim837P, type Submitter837 } from "./x12/x12-837p";
import { transactionSetControlNumber, wrapInterchange, type InterchangeEnvelope } from "./x12/x12-write";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** The statuses a claim can be sent from: reviewed, or denied and corrected. */
export const SENDABLE_STATUSES = ["ready_to_submit", "denied"] as const;

/** A batch whose claims' notes miss what their payers require, and no reason was given. */
export class SubmissionDocumentationError extends ValidationError {
  readonly gaps: { claimRef: string; superbillId: string; gap: DocumentationGap }[];
  constructor(gaps: { claimRef: string; superbillId: string; gap: DocumentationGap }[]) {
    super(
      gaps.length === 1
        ? `${gaps[0]!.claimRef}: ${documentationGapMessage(gaps[0]!.gap)}`
        : `${gaps.length} claims have documentation gaps for their payers (${gaps.map((g) => g.claimRef).join(", ")}). Give the reason they can go anyway; it is kept on each claim's history.`,
    );
    this.name = "SubmissionDocumentationError";
    this.gaps = gaps;
  }
}

interface SourceRow {
  id: string;
  visit_id: string | null;
  patient_id: string;
  status: string;
  dos: string;
  pos: string | null;
  cpt_codes: string[] | null;
  cpt_units: CodeUnits | null;
  modifiers: string[] | null;
  icd10_codes: string[] | null;
  pricing: Partial<SuperbillPricing> | null;
  member_id_snapshot: string | null;
  provider_name: string | null;
  provider_npi: string | null;
  rendering_taxonomy: string | null;
  payer_id: string | null;
  payer_name: string | null;
  payer_type: string | null;
  first_name: string;
  last_name: string;
  dob: string | null;
  sex: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  group_number: string | null;
  prior_pcn: string | null;
}

/** The claims, locked, with everything their 837P needs. */
async function loadSources(tx: Tx, orgId: string, ids: string[]): Promise<{ rows: SourceRow[]; sources: ClaimSource[] }> {
  const rows = await tx.$queryRaw<SourceRow[]>`
    SELECT s.id, s.visit_id, s.patient_id, s.status, to_char(s.date_of_service, 'YYYY-MM-DD') AS dos,
           s.place_of_service_code AS pos, s.cpt_codes, s.cpt_units, s.modifiers, s.icd10_codes, s.pricing,
           s.member_id_snapshot, s.provider_name, s.provider_npi, cp.taxonomy_code AS rendering_taxonomy,
           pay.id AS payer_id, pay.name::text AS payer_name, pay.payer_type,
           p.first_name, p.last_name, to_char(p.date_of_birth, 'YYYY-MM-DD') AS dob, p.sex_assigned_at_birth AS sex,
           p.address_line_1, p.address_line_2, p.city, p.state, p.zip, p.primary_group_number AS group_number,
           -- The payer's own number for the claim, when it has processed it:
           -- the latest 835 (CLP07), else the latest 277CA (REF*1K).
           COALESCE(
             (SELECT e.payer_claim_control_number FROM era_835_record e
               WHERE e.superbill_id = s.id AND e.payer_claim_control_number IS NOT NULL
               ORDER BY e.ingested_at DESC LIMIT 1),
             (SELECT i.payer_claim_number FROM claim_submission_item i
               WHERE i.superbill_id = s.id AND i.payer_claim_number IS NOT NULL
               ORDER BY i.updated_at DESC LIMIT 1)
           ) AS prior_pcn
      FROM superbill s
      JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
      LEFT JOIN visit v ON v.id = s.visit_id AND v.org_id = s.org_id
      LEFT JOIN clinician_profile cp ON cp.org_id = s.org_id AND cp.user_id = v.clinician_user_id
      LEFT JOIN payer pay ON pay.id = s.payer_id
     WHERE s.org_id = ${orgId}::uuid AND s.id = ANY(${ids}::uuid[])
     ORDER BY s.date_of_service, s.id
     FOR UPDATE OF s
  `;
  if (rows.length !== ids.length) throw new NotFoundError("A claim in the file was not found.");
  const billing = await readBillingProvider(tx, orgId);
  const referring = await readClaimReferring(tx, { orgId, on: billing.claimReferringProvider, patientIds: rows.map((r) => r.patient_id) });
  const authNumbers = await readClaimAuthNumbers(
    tx,
    orgId,
    rows.map((r) => ({ id: r.id, patientId: r.patient_id, payerId: r.payer_id, codes: r.cpt_codes ?? [], dos: r.dos })),
  );
  const sources = rows.map((r): ClaimSource => {
    const lines = r.pricing?.lines ?? [];
    return {
      superbillId: r.id,
      claimRef: claimRefFor(r.id),
      status: r.status,
      dateOfService: r.dos,
      placeOfService: r.pos,
      codes: r.cpt_codes ?? [],
      units: r.cpt_units ?? {},
      modifiers: r.modifiers ?? [],
      icd10: r.icd10_codes ?? [],
      chargeCents: Object.fromEntries(lines.map((l) => [l.code, lineChargeCents(l)])),
      patient: {
        lastName: r.last_name,
        firstName: r.first_name,
        dob: r.dob,
        sex: r.sex,
        address: r.address_line_1 && r.city && r.state && r.zip
          ? { line1: r.address_line_1, line2: r.address_line_2, city: r.city, state: r.state, zip: r.zip }
          : null,
      },
      memberId: r.member_id_snapshot ?? "",
      groupNumber: r.group_number,
      payer: r.payer_id && r.payer_name && r.payer_type ? { id: r.payer_id, name: r.payer_name, type: r.payer_type } : null,
      rendering: { name: r.provider_name ?? "", npi: r.provider_npi ?? "", taxonomy: r.rendering_taxonomy },
      billing: {
        name: billing.legalName,
        npi: billing.npi,
        ein: billing.ein,
        taxonomy: billing.taxonomyCode,
        address: billing.address ? { ...billing.address, line2: billing.address.line2 ?? null } : null,
        payTo: billing.payTo ? { ...billing.payTo, line2: billing.payTo.line2 ?? null } : null,
      },
      referring: referring.get(r.patient_id),
      priorAuthNumber: authNumbers.get(r.id) ?? null,
      priorPayerClaimNumber: r.prior_pcn,
    };
  });
  return { rows, sources };
}

async function payerIdsFor(tx: Tx, orgId: string, connectionId: string): Promise<Map<string, PayerIdMapping>> {
  const rows = await tx.$queryRaw<{ payer_id: string; external_payer_id: string; claim_filing_indicator: string | null }[]>`
    SELECT payer_id, external_payer_id, claim_filing_indicator FROM clearinghouse_payer_id
     WHERE org_id = ${orgId}::uuid AND connection_id = ${connectionId}::uuid
  `;
  return new Map(rows.map((r) => [r.payer_id, { externalPayerId: r.external_payer_id, claimFilingIndicator: r.claim_filing_indicator }]));
}

async function nextControlNumbers(tx: Tx): Promise<{ icn: number; gcn: number }> {
  const r = await tx.$queryRaw<{ icn: bigint; gcn: bigint }[]>`
    SELECT nextval('x12_interchange_control_seq') AS icn, nextval('x12_group_control_seq') AS gcn
  `;
  return { icn: Number(r[0]!.icn), gcn: Number(r[0]!.gcn) };
}

/** The interchange envelope a connection's files carry. */
export function envelopeFor(
  c: Pick<LoadedConnection, "settings" | "environment">,
  n: { icn: number; gcn: number },
  functionalId: InterchangeEnvelope["functionalId"],
  version: string,
  now: Date,
): InterchangeEnvelope {
  return {
    senderQualifier: c.settings.senderQualifier,
    senderId: c.settings.submitter.id,
    receiverQualifier: c.settings.receiver.qualifier,
    receiverId: c.settings.receiver.id,
    gsSenderCode: c.settings.submitter.id,
    gsReceiverCode: c.settings.receiver.gsCode,
    usage: c.environment === "production" ? "P" : "T",
    interchangeControlNumber: n.icn,
    groupControlNumber: n.gcn,
    functionalId,
    version,
    now,
    ackRequested: "1",
  };
}

export function submitterFor(c: Pick<LoadedConnection, "settings">): Submitter837 {
  const s = c.settings;
  return {
    id: s.submitter.id,
    name: s.submitter.name,
    contactName: s.submitter.contactName,
    contactPhone: s.submitter.contactPhone,
    contactEmail: s.submitter.contactEmail,
    receiverName: s.receiver.name,
    receiverId: s.receiver.loop1000BId,
  };
}

interface BuiltFile {
  filename: string;
  content: string;
  sha256: string;
  icn: number;
  gcn: number;
  items: { superbillId: string; claimRef: string; st02: string; frequency: "1" | "7" | "8" }[];
  warnings: { claimRef: string; warnings: string[] }[];
}

async function buildFile(tx: Tx, orgId: string, conn: LoadedConnection, sources: ClaimSource[], now: Date): Promise<BuiltFile> {
  const payerIds = await payerIdsFor(tx, orgId, conn.id);
  const mapped = sources.map((s) => ({
    s,
    m: claimTo837(s, { settings: conn.settings, vendorName: conn.vendorName, payerId: s.payer ? payerIds.get(s.payer.id) ?? null : null }),
  }));
  const stopped = mapped.filter((x) => x.m.stops.length > 0 || !x.m.claim);
  if (stopped.length > 0) {
    // One line per claim, each gap with where it is put right: the screens
    // show this with its line breaks.
    throw new ValidationError(
      [
        `The claim file wasn't created: ${stopped.length === 1 ? "1 claim is" : `${stopped.length} claims are`} missing what ${conn.vendorName} needs.`,
        ...stopped.map((x) => `• ${x.s.claimRef}: ${x.m.stops.join("; ")}`),
        "Fix these, then try again.",
      ].join("\n"),
    );
  }
  const n = await nextControlNumbers(tx);
  const submitter = submitterFor(conn);
  const items: BuiltFile["items"] = [];
  const sets = mapped.map(({ s, m }, i) => {
    const st02 = transactionSetControlNumber(i + 1);
    items.push({ superbillId: s.superbillId, claimRef: s.claimRef, st02, frequency: m.claim!.frequency });
    return buildClaim837P({ controlNumber: st02, reference: `${n.gcn}S${i + 1}`, now, submitter, claim: m.claim! });
  });
  const content = wrapInterchange(envelopeFor(conn, n, "HC", "005010X222A1", now), sets);
  const extension = conn.settings.sftp?.fileExtension ?? ".txt";
  return {
    filename: claimFileName(n.icn, extension),
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    icn: n.icn,
    gcn: n.gcn,
    items,
    warnings: mapped.filter((x) => x.m.warnings.length > 0).map((x) => ({ claimRef: x.s.claimRef, warnings: x.m.warnings })),
  };
}

async function recordSubmission(
  tx: Tx,
  a: { orgId: string; userId: string; conn: LoadedConnection; file: BuiltFile; channel: "sftp" | "download"; state: "sending" | "downloaded" },
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO claim_submission (
      org_id, connection_id, vendor, channel, usage_indicator, interchange_control_number, group_control_number,
      filename, content_sha256, byte_size, claim_count, state, created_by_user_id
    ) VALUES (
      ${a.orgId}::uuid, ${a.conn.id}::uuid, ${a.conn.vendor}, ${a.channel},
      ${a.conn.environment === "production" ? "P" : "T"}, ${a.file.icn}, ${a.file.gcn},
      ${a.file.filename}, ${a.file.sha256}, ${Buffer.byteLength(a.file.content)}::int, ${a.file.items.length}::int,
      ${a.state}, ${a.userId}::uuid
    )
    RETURNING id
  `;
  const id = rows[0]!.id;
  for (const it of a.file.items) {
    await tx.$executeRaw`
      INSERT INTO claim_submission_item (
        submission_id, org_id, superbill_id, transaction_set_control_number, claim_ref, frequency_code, send_state
      ) VALUES (
        ${id}::uuid, ${a.orgId}::uuid, ${it.superbillId}::uuid, ${it.st02}, ${it.claimRef}, ${it.frequency}, ${a.state}
      )
    `;
  }
  return id;
}

function assertIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new ValidationError("Pick the claims to put in the file.");
  if (unique.length > 500) throw new ValidationError("A file carries at most 500 claims; send them in smaller batches.");
  return unique;
}

export interface DownloadedFile {
  submissionId: string;
  filename: string;
  content: string;
  claims: number;
  warnings: { claimRef: string; warnings: string[] }[];
}

/**
 * Build the 837P for the practice to upload to the clearinghouse itself.
 * Reviewed claims only, as the CSV export (ready to submit, submitted, or
 * denied for a refile).
 */
export async function downloadClaimFile(args: {
  orgId: string;
  userId: string;
  connectionId: string;
  superbillIds: string[];
  now?: Date;
}): Promise<DownloadedFile> {
  const ids = assertIds(args.superbillIds);
  const now = args.now ?? new Date();
  const out = await withOrgContext(args.orgId, async (tx) => {
    const conn = await loadConnection(tx, args.orgId, args.connectionId, { withSecrets: false });
    if (conn.status !== "active") throw new ValidationError("This connection is switched off. Switch it on, or pick another.");
    const { rows, sources } = await loadSources(tx, args.orgId, ids);
    const unreviewed = sources.filter((s) => !(EXPORTABLE_STATUSES as readonly string[]).includes(s.status));
    if (unreviewed.length > 0) {
      throw new ValidationError(
        [
          "Only reviewed claims can go in a file:",
          ...unreviewed.map((s) => `• ${s.claimRef} is ${s.status === "draft" ? "a draft. Mark it Ready to submit on its bill page first" : s.status.replace(/_/g, " ")}`),
        ].join("\n"),
      );
    }
    for (const s of sources) await assertNotSending(tx, args.orgId, s.superbillId);
    const file = await buildFile(tx, args.orgId, conn, sources, now);
    const submissionId = await recordSubmission(tx, { orgId: args.orgId, userId: args.userId, conn, file, channel: "download", state: "downloaded" });
    for (const s of sources) {
      await tx.$executeRaw`
        INSERT INTO superbill_activity (org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail)
        VALUES (${args.orgId}::uuid, ${s.superbillId}::uuid, ${args.userId}::uuid, 'clearinghouse', ${s.status}, ${s.status},
                ${`837P file built for ${conn.vendorName} and downloaded: ${file.filename}`},
                ${JSON.stringify({ submissionId, event: "downloaded", interchangeControlNumber: file.icn })}::jsonb)
      `;
    }
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "claim_submission",
      targetType: "claim_submission",
      targetId: submissionId,
      payload: { op: "download", vendor: conn.vendor, claims: file.items.length, superbillIds: file.items.map((i) => i.superbillId) },
    });
    return {
      result: { submissionId, filename: file.filename, content: file.content, claims: file.items.length, warnings: file.warnings },
      patientIds: [...new Set(rows.map((r) => r.patient_id))],
    };
  });
  void logPhiExport({
    orgId: args.orgId,
    userId: args.userId,
    exportType: "claim_837",
    patientIds: out.patientIds,
    byteSize: Buffer.byteLength(out.result.content),
  });
  return out.result;
}

export interface SubmitResult {
  submissionId: string;
  filename: string;
  state: "sent" | "send_failed";
  /** Sent to the clearinghouse's test system: no claim was marked submitted. */
  test: boolean;
  claims: number;
  /** Claims the file carried that Pallio then failed to record as submitted (should be none). */
  notRecorded: { claimRef: string; message: string }[];
  error: string | null;
  warnings: { claimRef: string; warnings: string[] }[];
}

/**
 * The checks a person's "Record as submitted" runs, for every claim, before
 * the file is built. A test file submits nothing, so it asks no reason for a
 * documentation gap: there is no submission to record the reason on.
 */
async function preflight(
  tx: Tx,
  orgId: string,
  sources: ClaimSource[],
  documentationOverride: { reason: string } | undefined,
  opts: { test: boolean },
): Promise<void> {
  const problems: string[] = [];
  const gaps: SubmissionDocumentationError["gaps"] = [];
  for (const s of sources) {
    if (!(SENDABLE_STATUSES as readonly string[]).includes(s.status)) {
      problems.push(`${s.claimRef} is ${s.status === "submitted" ? "already submitted" : s.status === "draft" ? "a draft. Mark it Ready to submit on its bill page first" : s.status.replace(/_/g, " ")}`);
      continue;
    }
    await assertNotSending(tx, orgId, s.superbillId);
    const checks = await loadReviewChecks(tx, { orgId, superbillId: s.superbillId });
    if (checks.hardStops.length > 0) problems.push(`${s.claimRef}: ${hardStopMessage(checks.hardStops)}`);
    if (opts.test) continue;
    const docs = await loadDocumentationGaps(tx, { superbillId: s.superbillId });
    const gap = documentationGap(docs.results, docs.payerName);
    if (gap && !documentationOverride?.reason.trim()) gaps.push({ claimRef: s.claimRef, superbillId: s.superbillId, gap });
  }
  if (problems.length > 0) throw new ValidationError(["Nothing was sent:", ...problems.map((p) => `• ${p}`)].join("\n"));
  if (gaps.length > 0) throw new SubmissionDocumentationError(gaps);
}

/** Build the file, send it over SFTP, and record each claim submitted. */
export async function submitClaims(args: {
  orgId: string;
  userId: string;
  connectionId: string;
  superbillIds: string[];
  documentationOverride?: { reason: string };
  now?: Date;
}): Promise<SubmitResult> {
  const ids = assertIds(args.superbillIds);
  const now = args.now ?? new Date();

  // 1. Check, build, and record the file as sending.
  const staged = await withOrgContext(args.orgId, async (tx) => {
    const conn = await loadConnection(tx, args.orgId, args.connectionId);
    if (conn.status !== "active") throw new ValidationError("This connection is switched off. Switch it on, or pick another.");
    if (conn.batchChannel !== "sftp" || !conn.settings.sftp) {
      throw new ValidationError(`This ${conn.vendorName} connection has no SFTP channel: download the file and upload it to ${conn.vendorName} yourself, or add SFTP on the connection.`);
    }
    const { rows, sources } = await loadSources(tx, args.orgId, ids);
    await preflight(tx, args.orgId, sources, args.documentationOverride, { test: conn.environment === "test" });
    const file = await buildFile(tx, args.orgId, conn, sources, now);
    const submissionId = await recordSubmission(tx, { orgId: args.orgId, userId: args.userId, conn, file, channel: "sftp", state: "sending" });
    return { conn, file, submissionId, patientIds: [...new Set(rows.map((r) => r.patient_id))], statuses: new Map(sources.map((s) => [s.superbillId, s.status])) };
  });
  const { conn, file, submissionId } = staged;

  // 2. The upload.
  let error: string | null = null;
  try {
    const s = conn.settings.sftp!;
    const session = await openSftp({
      host: s.host, port: s.port, username: s.username, password: conn.secrets.sftpPassword,
      privateKey: conn.secrets.sftpPrivateKey, passphrase: conn.secrets.sftpPassphrase, hostKeySha256: conn.hostKeySha256,
    });
    try {
      await session.put(s.uploadDir, file.filename, Buffer.from(file.content, "utf8"));
    } finally {
      session.close();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "The upload failed.";
  }

  if (error) {
    await withOrgContext(args.orgId, async (tx) => {
      await tx.$executeRaw`
        UPDATE claim_submission SET state = 'send_failed', error_message = ${error!.slice(0, 1000)}
         WHERE org_id = ${args.orgId}::uuid AND id = ${submissionId}::uuid
      `;
      await tx.$executeRaw`
        UPDATE claim_submission_item SET send_state = 'send_failed', updated_at = now()
         WHERE org_id = ${args.orgId}::uuid AND submission_id = ${submissionId}::uuid
      `;
      for (const it of file.items) {
        const st = staged.statuses.get(it.superbillId) ?? null;
        await tx.$executeRaw`
          INSERT INTO superbill_activity (org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail)
          VALUES (${args.orgId}::uuid, ${it.superbillId}::uuid, ${args.userId}::uuid, 'clearinghouse', ${st}, ${st},
                  ${`Not sent to ${conn.vendorName}: ${error}`},
                  ${JSON.stringify({ submissionId, event: "send_failed" })}::jsonb)
        `;
      }
      await writeAudit(tx, {
        orgId: args.orgId, userId: args.userId, action: "claim_submission", targetType: "claim_submission", targetId: submissionId,
        payload: { op: "send_failed", vendor: conn.vendor, claims: file.items.length },
      });
    });
    return { submissionId, filename: file.filename, state: "send_failed", test: conn.environment === "test", claims: file.items.length, notRecorded: [], error, warnings: file.warnings };
  }

  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE claim_submission SET state = 'sent', sent_at = now() WHERE org_id = ${args.orgId}::uuid AND id = ${submissionId}::uuid
    `;
    await tx.$executeRaw`
      UPDATE claim_submission_item SET send_state = 'sent', updated_at = now()
       WHERE org_id = ${args.orgId}::uuid AND submission_id = ${submissionId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "claim_submission", targetType: "claim_submission", targetId: submissionId,
      payload: { op: "send", vendor: conn.vendor, claims: file.items.length, superbillIds: file.items.map((i) => i.superbillId) },
    });
  });
  void logPhiExport({ orgId: args.orgId, userId: args.userId, exportType: "claim_837", patientIds: staged.patientIds, byteSize: Buffer.byteLength(file.content) });

  // A test file goes to the clearinghouse's test system, which never passes
  // it to a payer: each claim stays as it was, and says so on its history.
  if (conn.environment === "test") {
    await withOrgContext(args.orgId, async (tx) => {
      for (const it of file.items) {
        const st = staged.statuses.get(it.superbillId) ?? null;
        await tx.$executeRaw`
          INSERT INTO superbill_activity (org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail)
          VALUES (${args.orgId}::uuid, ${it.superbillId}::uuid, ${args.userId}::uuid, 'clearinghouse', ${st}, ${st},
                  ${`Test file sent to ${conn.vendorName} in ${file.filename}. The claim's status doesn't change: test files never reach the payer.`},
                  ${JSON.stringify({ submissionId, event: "sent", test: true })}::jsonb)
        `;
      }
    });
    return { submissionId, filename: file.filename, state: "sent", test: true, claims: file.items.length, notRecorded: [], error: null, warnings: file.warnings };
  }

  // 3. Each claim, submitted, in its own transaction.
  const notRecorded: SubmitResult["notRecorded"] = [];
  for (const it of file.items) {
    try {
      await withOrgContext(args.orgId, (tx) =>
        markStatusTx(tx, {
          orgId: args.orgId,
          id: it.superbillId,
          to: "submitted",
          actorUserId: args.userId,
          ...(args.documentationOverride ? { documentationOverride: args.documentationOverride } : {}),
          source: { kind: "clearinghouse", event: "sent", submissionId, vendorName: conn.vendorName, filename: file.filename },
        }),
      );
    } catch (err) {
      notRecorded.push({ claimRef: it.claimRef, message: err instanceof Error ? err.message : "Not recorded." });
    }
  }
  return { submissionId, filename: file.filename, state: "sent", test: false, claims: file.items.length, notRecorded, error: null, warnings: file.warnings };
}

/** What a claim cannot go out without, for the queue to say before Send: per claim, per connection. */
export async function previewClaims(args: { orgId: string; connectionId: string; superbillIds: string[] }): Promise<{ claimRef: string; superbillId: string; stops: string[]; warnings: string[] }[]> {
  const ids = assertIds(args.superbillIds);
  return withOrgContext(args.orgId, async (tx) => {
    const conn = await loadConnection(tx, args.orgId, args.connectionId, { withSecrets: false });
    const payerIds = await payerIdsFor(tx, args.orgId, conn.id);
    // The same read the file is built from, so the preview cannot disagree
    // with the build. Its row locks last only this short transaction.
    const { sources } = await loadSources(tx, args.orgId, ids);
    return sources.map((s) => {
      const m = claimTo837(s, { settings: conn.settings, vendorName: conn.vendorName, payerId: s.payer ? payerIds.get(s.payer.id) ?? null : null });
      return { claimRef: s.claimRef, superbillId: s.superbillId, stops: m.stops, warnings: m.warnings };
    });
  });
}
