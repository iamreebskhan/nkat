/**
 * Prior authorizations on the chart (0124). See prior-auth.ts for what one
 * covers. Added by whoever edits the chart or the bill; a mistaken one is
 * withdrawn, not deleted. The audit row carries ids and field names, never the
 * authorization number.
 */
import { z } from "zod";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { coveringAuth, type PriorAuth } from "@/lib/features/billing/prior-auth";
import { isCalendarDay } from "@/lib/features/org/org-date";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(isCalendarDay, "Not a calendar day.");

export const PriorAuthSchema = z
  .object({
    payerId: z.string().uuid("Choose the plan"),
    authNumber: z.string().trim().regex(/^[A-Za-z0-9-]{1,50}$/, "The authorization number: letters, digits and hyphens, as the payer gave it"),
    codes: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5}$/, "A CPT or HCPCS code is five characters")).max(50),
    validFrom: Day,
    validTo: Day,
    visitsAuthorized: z.number().int().min(1).max(9999).nullable(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.validTo < b.validFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The authorization ends before it starts." });
  });
export type PriorAuthInput = z.infer<typeof PriorAuthSchema>;

export interface PriorAuthView extends PriorAuth {
  payerName: string | null;
  /** Bills on this authorization so far, not counting voided ones. */
  visitsUsed: number;
  createdByName: string | null;
}

type Row = {
  id: string; payer_id: string; payer_name: string | null; auth_number: string; codes: string[]; valid_from: string; valid_to: string;
  visits_authorized: number | null; status: "active" | "withdrawn"; visits_used: bigint | number; created_by_name: string | null;
};

const toView = (r: Row): PriorAuthView => ({
  id: r.id, payerId: r.payer_id, payerName: r.payer_name, authNumber: r.auth_number, codes: r.codes ?? [],
  validFrom: r.valid_from, validTo: r.valid_to, visitsAuthorized: r.visits_authorized === null ? null : Number(r.visits_authorized),
  status: r.status, visitsUsed: Number(r.visits_used), createdByName: r.created_by_name,
});

async function readAuths(tx: Tx, orgId: string, patientId: string): Promise<PriorAuthView[]> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT a.id, a.payer_id, pay.name::text AS payer_name, a.auth_number, a.codes,
           to_char(a.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(a.valid_to, 'YYYY-MM-DD') AS valid_to,
           a.visits_authorized, a.status, COALESCE(u.full_name, u.email) AS created_by_name,
           (SELECT count(*) FROM superbill s
             WHERE s.org_id = a.org_id AND s.patient_id = a.patient_id AND s.payer_id = a.payer_id
               AND s.status <> 'voided' AND s.date_of_service BETWEEN a.valid_from AND a.valid_to
               AND (cardinality(a.codes) = 0 OR s.cpt_codes && a.codes)) AS visits_used
      FROM patient_prior_auth a
      LEFT JOIN payer pay ON pay.id = a.payer_id
      LEFT JOIN app_user u ON u.id = a.created_by_user_id
     WHERE a.org_id = ${orgId}::uuid AND a.patient_id = ${patientId}::uuid AND a.status = 'active'
     ORDER BY a.valid_to DESC, a.created_at DESC
  `;
  return rows.map(toView);
}

/** The patient's plans an authorization can be for. */
async function readPlans(tx: Tx, orgId: string, patientId: string): Promise<{ id: string; name: string }[]> {
  return tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT pay.id, pay.name::text AS name
      FROM patient p
      JOIN payer pay ON pay.id IN (p.primary_payer_id, p.secondary_payer_id)
     WHERE p.id = ${patientId}::uuid AND p.org_id = ${orgId}::uuid
     ORDER BY (pay.id = p.primary_payer_id) DESC
  `;
}

export async function listPriorAuths(args: { orgId: string; patientId: string }): Promise<{ auths: PriorAuthView[]; plans: { id: string; name: string }[] }> {
  return withOrgContext(args.orgId, async (tx) => ({
    auths: await readAuths(tx, args.orgId, args.patientId),
    plans: await readPlans(tx, args.orgId, args.patientId),
  }));
}

async function assertPlan(tx: Tx, orgId: string, patientId: string, payerId: string): Promise<void> {
  const exists = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM patient WHERE id = ${patientId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
  `;
  if (!exists[0]) throw new NotFoundError("Patient not found.");
  const plans = await readPlans(tx, orgId, patientId);
  if (!plans.some((p) => p.id === payerId)) throw new ValidationError("That plan is not on this patient's chart.");
}

export async function addPriorAuth(args: { orgId: string; userId: string; patientId: string; input: PriorAuthInput }): Promise<{ id: string }> {
  const p = args.input;
  return withOrgContext(args.orgId, async (tx) => {
    await assertPlan(tx, args.orgId, args.patientId, p.payerId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_prior_auth (org_id, patient_id, payer_id, auth_number, codes, valid_from, valid_to, visits_authorized, created_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${p.payerId}::uuid, ${p.authNumber}, ${[...new Set(p.codes)]}::text[],
              ${p.validFrom}::date, ${p.validTo}::date, ${p.visitsAuthorized}, ${args.userId}::uuid)
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "prior_auth_change", targetType: "patient", targetId: args.patientId,
      payload: { change: "add", authId: rows[0]!.id },
    });
    return { id: rows[0]!.id };
  });
}

export async function updatePriorAuth(args: { orgId: string; userId: string; patientId: string; authId: string; input: PriorAuthInput }): Promise<void> {
  const p = args.input;
  return withOrgContext(args.orgId, async (tx) => {
    await assertPlan(tx, args.orgId, args.patientId, p.payerId);
    const before = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient_prior_auth
       WHERE id = ${args.authId}::uuid AND org_id = ${args.orgId}::uuid AND patient_id = ${args.patientId}::uuid AND status = 'active'
       FOR UPDATE
    `;
    if (!before[0]) throw new NotFoundError("That authorization is not on this chart.");
    await tx.$executeRaw`
      UPDATE patient_prior_auth
         SET payer_id = ${p.payerId}::uuid, auth_number = ${p.authNumber}, codes = ${[...new Set(p.codes)]}::text[],
             valid_from = ${p.validFrom}::date, valid_to = ${p.validTo}::date, visits_authorized = ${p.visitsAuthorized}, updated_at = now()
       WHERE id = ${args.authId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "prior_auth_change", targetType: "patient", targetId: args.patientId,
      payload: { change: "edit", authId: args.authId },
    });
  });
}

/** Recorded in error: it stops counting, and the row stays. */
export async function withdrawPriorAuth(args: { orgId: string; userId: string; patientId: string; authId: string }): Promise<void> {
  return withOrgContext(args.orgId, async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE patient_prior_auth SET status = 'withdrawn', updated_at = now()
       WHERE id = ${args.authId}::uuid AND org_id = ${args.orgId}::uuid AND patient_id = ${args.patientId}::uuid AND status = 'active'
    `;
    if (changed === 0) throw new NotFoundError("That authorization is not on this chart.");
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "prior_auth_change", targetType: "patient", targetId: args.patientId,
      payload: { change: "withdraw", authId: args.authId },
    });
  });
}

/** Active authorizations of these patients, as claims and the review need them. */
export async function readActiveAuths(tx: Tx, orgId: string, patientIds: string[]): Promise<Map<string, PriorAuth[]>> {
  const rows = await tx.$queryRaw<(Omit<Row, "payer_name" | "visits_used" | "created_by_name"> & { patient_id: string })[]>`
    SELECT id, patient_id, payer_id, auth_number, codes, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
           to_char(valid_to, 'YYYY-MM-DD') AS valid_to, visits_authorized, status
      FROM patient_prior_auth
     WHERE org_id = ${orgId}::uuid AND patient_id = ANY(${patientIds}::uuid[]) AND status = 'active'
  `;
  const out = new Map<string, PriorAuth[]>();
  for (const r of rows) {
    const list = out.get(r.patient_id) ?? [];
    list.push({
      id: r.id, payerId: r.payer_id, authNumber: r.auth_number, codes: r.codes ?? [], validFrom: r.valid_from, validTo: r.valid_to,
      visitsAuthorized: r.visits_authorized === null ? null : Number(r.visits_authorized), status: r.status,
    });
    out.set(r.patient_id, list);
  }
  return out;
}

/** The number box 23 and REF*G1 carry for each claim, by superbill id; absent when none covers it. */
export async function readClaimAuthNumbers(
  tx: Tx,
  orgId: string,
  claims: { id: string; patientId: string; payerId: string | null; codes: string[]; dos: string }[],
): Promise<Map<string, string>> {
  const auths = await readActiveAuths(tx, orgId, [...new Set(claims.map((c) => c.patientId))]);
  const out = new Map<string, string>();
  for (const c of claims) {
    const a = coveringAuth(auths.get(c.patientId) ?? [], c);
    if (a) out.set(c.id, a.authNumber);
  }
  return out;
}
