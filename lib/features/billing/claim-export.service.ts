/**
 * Export claims for the billing software (0118; Level-1 doc:72; Mark Q1
 * default), and mark them sent to billing.
 *
 * Reviewed claims only (ready to submit, submitted, or denied for a refile): a
 * draft is reviewed on its bill page first. A claim with a hard stop (Mark Q5
 * default: no member ID, diagnosis or CPT code) refuses the whole export, named,
 * so nothing half-goes. The batch, each claim in it, a line on each claim's
 * history and one audit row are written in one transaction with the file's
 * hash; the disclosure is logged as a PHI export. The claims' statuses do not
 * move: sent to billing is not submitted to the payer, which the biller
 * records when it happens.
 */
import { createHash } from "node:crypto";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { readClaimAuthNumbers } from "@/lib/features/patients/prior-auth.service";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";
import { lineChargeCents, type SuperbillPricing } from "@/lib/features/superbills/superbill-pure";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import { readBillingProvider, readClaimReferring } from "./billing-provider.service";
import {
  EXPORTABLE_STATUSES,
  claimExportWarnings,
  claimHardStops,
  claimsCsv,
  type ClaimForExport,
  type ExportAddress,
} from "./claim-export";
import type { CodeUnits } from "./code-units";

interface Row {
  id: string;
  visit_id: string;
  patient_id: string;
  status: string;
  dos: string;
  pos: string | null;
  cpt_codes: string[] | null;
  cpt_units: CodeUnits | null;
  modifiers: string[] | null;
  icd10_codes: string[] | null;
  pricing: Partial<SuperbillPricing> | null;
  billed_amount_cents: bigint | number;
  expected_amount_cents: bigint | number | null;
  member_id_snapshot: string | null;
  provider_name: string | null;
  provider_npi: string | null;
  rendering_taxonomy: string | null;
  payer_id: string | null;
  payer_name: string | null;
  first_name: string;
  last_name: string;
  dob: string;
  sex: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  group_number: string | null;
  secondary_payer_name: string | null;
  secondary_member_id: string | null;
}

const addr = (l1: string | null, l2: string | null, city: string | null, state: string | null, zip: string | null): ExportAddress | null =>
  l1 && city && state && zip ? { line1: l1, ...(l2 ? { line2: l2 } : {}), city, state, zip } : null;

export interface ClaimExportResult {
  batchId: string;
  filename: string;
  csv: string;
  claims: number;
  lines: number;
  /** What each claim lacks that the billing software will want, by claim ref. */
  warnings: { claimRef: string; warnings: string[] }[];
}

export async function exportClaims(args: { orgId: string; userId: string; superbillIds: string[] }): Promise<ClaimExportResult> {
  const ids = [...new Set(args.superbillIds)];
  const result = await withOrgContext(args.orgId, async (tx) => {
    // Locked, so a claim cannot move status, or be edited, while it is being
    // written into the file that says what it was.
    const rows = await tx.$queryRaw<Row[]>`
      SELECT s.id, s.visit_id, s.patient_id, s.status, to_char(s.date_of_service, 'YYYY-MM-DD') AS dos,
             s.place_of_service_code AS pos, s.cpt_codes, s.cpt_units, s.modifiers, s.icd10_codes, s.pricing,
             s.billed_amount_cents, s.expected_amount_cents, s.member_id_snapshot,
             s.provider_name, s.provider_npi, cp.taxonomy_code AS rendering_taxonomy, s.payer_id, pay.name AS payer_name,
             p.first_name, p.last_name, to_char(p.date_of_birth, 'YYYY-MM-DD') AS dob, p.sex_assigned_at_birth AS sex,
             p.address_line_1, p.address_line_2, p.city, p.state, p.zip, p.primary_group_number AS group_number,
             sec.name AS secondary_payer_name, p.secondary_member_id
        FROM superbill s
        JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
        LEFT JOIN visit v ON v.id = s.visit_id AND v.org_id = s.org_id
        LEFT JOIN clinician_profile cp ON cp.org_id = s.org_id AND cp.user_id = v.clinician_user_id
        LEFT JOIN payer pay ON pay.id = s.payer_id
        LEFT JOIN payer sec ON sec.id = p.secondary_payer_id
       WHERE s.org_id = ${args.orgId}::uuid
         AND s.id = ANY(${ids}::uuid[])
       ORDER BY s.date_of_service, s.id
       FOR UPDATE OF s
    `;
    if (rows.length !== ids.length) throw new NotFoundError("A claim to export was not found.");

    const unreviewed = rows.filter((r) => !(EXPORTABLE_STATUSES as readonly string[]).includes(r.status));
    if (unreviewed.length > 0) {
      throw new ValidationError(
        `Only reviewed claims are exported. ${unreviewed
          .map((r) => `${claimRefFor(r.id)} is ${r.status === "draft" ? "a draft: review it on its bill page first" : r.status.replace(/_/g, " ")}`)
          .join("; ")}.`,
      );
    }

    const billing = await readBillingProvider(tx, args.orgId);
    const referring = await readClaimReferring(tx, {
      orgId: args.orgId, on: billing.claimReferringProvider, patientIds: rows.map((r) => r.patient_id),
    });
    const authNumbers = await readClaimAuthNumbers(
      tx,
      args.orgId,
      rows.map((r) => ({ id: r.id, patientId: r.patient_id, payerId: r.payer_id, codes: r.cpt_codes ?? [], dos: r.dos })),
    );
    const claims: ClaimForExport[] = rows.map((r) => {
      const lines = r.pricing?.lines ?? [];
      return {
        superbillId: r.id,
        visitId: r.visit_id,
        claimRef: claimRefFor(r.id),
        status: r.status,
        dateOfService: r.dos,
        placeOfService: r.pos ?? "",
        codes: r.cpt_codes ?? [],
        units: r.cpt_units ?? {},
        modifiers: r.modifiers ?? [],
        icd10: r.icd10_codes ?? [],
        chargeCents: Object.fromEntries(lines.map((l) => [l.code, lineChargeCents(l)])),
        billedCents: Number(r.billed_amount_cents),
        expectedCents: r.expected_amount_cents == null ? null : Number(r.expected_amount_cents),
        patient: {
          lastName: r.last_name, firstName: r.first_name, dob: r.dob, sex: r.sex,
          address: addr(r.address_line_1, r.address_line_2, r.city, r.state, r.zip),
        },
        payerName: r.payer_name,
        memberId: r.member_id_snapshot ?? "",
        groupNumber: r.group_number,
        secondary: r.secondary_payer_name || r.secondary_member_id
          ? { payerName: r.secondary_payer_name, memberId: r.secondary_member_id }
          : null,
        rendering: { name: r.provider_name ?? "", npi: r.provider_npi ?? "", taxonomy: r.rendering_taxonomy },
        billing: {
          name: billing.legalName, npi: billing.npi, ein: billing.ein, taxonomy: billing.taxonomyCode,
          address: billing.address, payTo: billing.payTo,
        },
        referring: referring.get(r.patient_id),
        priorAuthNumber: authNumbers.get(r.id) ?? null,
      };
    });

    const stopped = claims.map((c) => ({ c, stops: claimHardStops(c) })).filter((x) => x.stops.length > 0);
    if (stopped.length > 0) {
      throw new ValidationError(
        `Not exported: ${stopped.map((x) => `${x.c.claimRef} has ${x.stops.join(", ")}`).join("; ")}. A payer rejects a claim without these.`,
      );
    }

    const { csv, lines } = claimsCsv(claims);
    const sha = createHash("sha256").update(csv).digest("hex");
    const batch = await tx.$queryRaw<{ id: string; day: string }[]>`
      INSERT INTO claim_export_batch (org_id, created_by_user_id, claim_count, line_count, content_sha256)
      VALUES (${args.orgId}::uuid, ${args.userId}::uuid, ${claims.length}::int, ${lines}::int, ${sha})
      -- The file is named by the practice's day, as every date on the bill is;
      -- in UTC, an evening's export in Ohio was named for the next day.
      RETURNING id,
                to_char(created_at AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = ${args.orgId}::uuid),
                        'YYYY-MM-DD') AS day
    `;
    const batchId = batch[0]!.id;
    for (const c of claims) {
      await tx.$executeRaw`
        INSERT INTO claim_export_item (batch_id, org_id, superbill_id)
        VALUES (${batchId}::uuid, ${args.orgId}::uuid, ${c.superbillId}::uuid)
      `;
      await tx.$executeRaw`
        INSERT INTO superbill_activity (org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail)
        VALUES (${args.orgId}::uuid, ${c.superbillId}::uuid, ${args.userId}::uuid, 'exported', ${c.status}, ${c.status},
                ${`Sent to billing: exported in batch ${batchId.slice(0, 8)}`},
                ${JSON.stringify({ batchId, claims: claims.length })}::jsonb)
      `;
    }
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "claim_export",
      targetType: "claim_export",
      targetId: batchId,
      payload: { batchId, claims: claims.length, lines, superbillIds: claims.map((c) => c.superbillId) },
    });
    const out: ClaimExportResult = {
      batchId,
      filename: `pallio-claims-${batch[0]!.day}-${batchId.slice(0, 8)}.csv`,
      csv,
      claims: claims.length,
      lines,
      warnings: claims
        .map((c) => ({ claimRef: c.claimRef, warnings: claimExportWarnings(c) }))
        .filter((w) => w.warnings.length > 0),
    };
    return { out, patientIds: [...new Set(rows.map((r) => r.patient_id))] };
  });

  // A disclosure of PHI, logged as the patient record export is.
  void logPhiExport({
    orgId: args.orgId,
    userId: args.userId,
    exportType: "claim_csv",
    patientIds: result.patientIds,
    byteSize: Buffer.byteLength(result.out.csv),
  });
  return result.out;
}
