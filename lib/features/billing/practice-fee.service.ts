/**
 * The practice's own fee schedule (0118; Level-1 doc:74; Mark Q4 default:
 * "we add a practice fee schedule (billed = your fee, expected = the payer's
 * rate), empty until you send yours").
 *
 * One fee in force per code. A new fee for a code starts on its day and ends
 * the one before it on that day; a fee can also be ended outright. Nothing is
 * deleted, so what a bill was priced at stays answerable. Bills already priced
 * keep their price until they are edited and repriced.
 */
import { z } from "zod";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { isCalendarDay, orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(isCalendarDay, "Not a calendar day.");

export const SetFeeSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5}$/, "A CPT or HCPCS code is five characters"),
    feeCents: z.number().int().min(1, "A fee is more than $0").max(10_000_000, "At most $100,000"),
    effectiveFrom: Day,
  })
  .strict();
export type SetFee = z.infer<typeof SetFeeSchema>;

export const EndFeeSchema = z.object({ endOn: Day }).strict();

export interface PracticeFeeView {
  id: string;
  code: string;
  feeCents: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdByName: string | null;
}

export async function listPracticeFees(args: { orgId: string }): Promise<{ today: string; rows: PracticeFeeView[] }> {
  return withOrgContext(args.orgId, async (tx) => {
    const today = orgToday(await readOrgTimeZone(tx, args.orgId));
    const rows = await tx.$queryRaw<
      { id: string; code: string; fee_cents: number; effective_from: string; effective_to: string | null; created_by_name: string | null }[]
    >`
      SELECT f.id, f.code, f.fee_cents, to_char(f.effective_from, 'YYYY-MM-DD') AS effective_from,
             to_char(f.effective_to, 'YYYY-MM-DD') AS effective_to, COALESCE(u.full_name, u.email) AS created_by_name
        FROM practice_fee f
        LEFT JOIN app_user u ON u.id = f.created_by_user_id
       WHERE f.org_id = ${args.orgId}::uuid
       ORDER BY f.code, f.effective_from DESC
    `;
    return {
      today,
      rows: rows.map((r) => ({
        id: r.id, code: r.code, feeCents: Number(r.fee_cents), effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to, createdByName: r.created_by_name,
      })),
    };
  });
}

/** Set a code's fee from a day: it ends the fee in force before it, on that day. */
export async function setPracticeFee(args: { orgId: string; userId: string; payload: SetFee }): Promise<{ id: string }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const known = await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM code WHERE code = ${p.code}`;
    if (!known[0]) throw new ValidationError(`${p.code} is not a code Pallio knows.`);
    const current = await tx.$queryRaw<{ id: string; effective_from: string }[]>`
      SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from FROM practice_fee
       WHERE org_id = ${args.orgId}::uuid AND code = ${p.code} AND effective_to IS NULL
       FOR UPDATE
    `;
    if (current[0]) {
      if (p.effectiveFrom <= current[0].effective_from) {
        throw new ValidationError(
          `${p.code}'s fee from ${current[0].effective_from} is in force. A new fee starts after that day.`,
        );
      }
      await tx.$executeRaw`
        UPDATE practice_fee SET effective_to = ${p.effectiveFrom}::date
         WHERE id = ${current[0].id}::uuid AND org_id = ${args.orgId}::uuid
      `;
    }
    // An ended fee that ran past this day, or one starting on or after it,
    // would overlap the new one.
    const overlap = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM practice_fee
       WHERE org_id = ${args.orgId}::uuid AND code = ${p.code}
         AND (effective_from >= ${p.effectiveFrom}::date OR effective_to > ${p.effectiveFrom}::date)
    `;
    if (overlap[0]) throw new ValidationError(`${p.code} already has a fee from that day or after it.`);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO practice_fee (org_id, code, fee_cents, effective_from, created_by_user_id)
      VALUES (${args.orgId}::uuid, ${p.code}, ${p.feeCents}::int, ${p.effectiveFrom}::date, ${args.userId}::uuid)
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "settings_update",
      targetType: "fee_schedule",
      targetId: rows[0]!.id,
      payload: { change: current[0] ? "edit" : "create", code: p.code },
    });
    return { id: rows[0]!.id };
  });
}

/** End a fee on a day: from then the code bills at the payer's rate again. */
export async function endPracticeFee(args: {
  orgId: string; userId: string; feeId: string; endOn: string;
}): Promise<{ updated: true }> {
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ code: string; effective_from: string; effective_to: string | null }[]>`
      SELECT code, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to
        FROM practice_fee WHERE id = ${args.feeId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Fee not found.");
    if (cur[0].effective_to) throw new ValidationError(`This fee ended on ${cur[0].effective_to}.`);
    if (args.endOn <= cur[0].effective_from) {
      throw new ValidationError(`The fee starts on ${cur[0].effective_from}; it ends after that day.`);
    }
    await tx.$executeRaw`
      UPDATE practice_fee SET effective_to = ${args.endOn}::date
       WHERE id = ${args.feeId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "settings_update",
      targetType: "fee_schedule",
      targetId: args.feeId,
      payload: { change: "end", code: cur[0].code },
    });
    return { updated: true };
  });
}
