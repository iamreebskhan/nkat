/**
 * The practice's discharge and NTUC reason codes (0111, reason-codes.ts).
 *
 * The defaults are written the first time a practice's codes are read, in the
 * same transaction, so every practice has them however it was created —
 * signup, a seed, an import — with one list in one place.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import {
  DEFAULT_REASON_CODES,
  REASON_CODE_PATTERN,
  type ReasonCategory,
  type ReasonCodeKind,
} from "./reason-codes";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

export interface ReasonCodeView {
  id: string;
  kind: ReasonCodeKind;
  code: string;
  label: string;
  category: ReasonCategory;
  active: boolean;
  sortOrder: number;
}

interface Row {
  id: string;
  kind: ReasonCodeKind;
  code: string;
  label: string;
  category: ReasonCategory;
  active: boolean;
  sort_order: number;
}

const toView = (r: Row): ReasonCodeView => ({
  id: r.id,
  kind: r.kind,
  code: r.code,
  label: r.label,
  category: r.category,
  active: r.active,
  sortOrder: r.sort_order,
});

/**
 * Write the default codes for a practice that has none. A practice that has
 * any keeps what it has: a renamed or retired default stays as it was left.
 */
export async function ensureReasonCodes(tx: Tx, orgId: string): Promise<void> {
  const have = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM org_reason_code WHERE org_id = ${orgId}::uuid
  `;
  if (Number(have[0]?.n ?? 0) > 0) return;
  for (const c of DEFAULT_REASON_CODES) {
    await tx.$executeRaw`
      INSERT INTO org_reason_code (org_id, kind, code, label, category, sort_order)
      VALUES (${orgId}::uuid, ${c.kind}, ${c.code}, ${c.label}, ${c.category}, ${c.sortOrder})
      ON CONFLICT (org_id, kind, code) DO NOTHING
    `;
  }
}

export async function listReasonCodes(args: {
  orgId: string;
  kind?: ReasonCodeKind;
  includeRetired?: boolean;
}): Promise<ReasonCodeView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    await ensureReasonCodes(tx, args.orgId);
    const rows = await tx.$queryRaw<Row[]>`
      SELECT id, kind, code, label, category, active, sort_order
        FROM org_reason_code
       WHERE org_id = ${args.orgId}::uuid
         AND (${args.kind ?? null}::text IS NULL OR kind = ${args.kind ?? null})
         AND (${args.includeRetired === true} OR active)
       ORDER BY kind, sort_order, code
    `;
    return rows.map(toView);
  });
}

export async function createReasonCode(args: {
  orgId: string;
  userId: string;
  kind: ReasonCodeKind;
  code: string;
  label: string;
  category: ReasonCategory;
}): Promise<ReasonCodeView> {
  if (!REASON_CODE_PATTERN.test(args.code)) {
    throw new ValidationError("A code is two digits and an optional letter, like 21c.");
  }
  return withOrgContext(args.orgId, async (tx) => {
    await ensureReasonCodes(tx, args.orgId);
    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO org_reason_code (org_id, kind, code, label, category, sort_order)
      VALUES (
        ${args.orgId}::uuid, ${args.kind}, ${args.code}, ${args.label.trim()}, ${args.category},
        -- After the codes of its kind, so a new one lands at the bottom.
        COALESCE((SELECT max(sort_order) + 1 FROM org_reason_code
                   WHERE org_id = ${args.orgId}::uuid AND kind = ${args.kind}), 100)
      )
      ON CONFLICT (org_id, kind, code) DO NOTHING
      RETURNING id, kind, code, label, category, active, sort_order
    `;
    if (!rows[0]) {
      throw new ValidationError(
        `There is already ${args.kind === "ntuc" ? "an NTUC" : "a discharge"} code ${args.code}. Edit it instead.`,
      );
    }
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "reason_code_change",
      targetType: "reason_code",
      targetId: rows[0].id,
      payload: { op: "create", kind: args.kind, code: args.code },
    });
    return toView(rows[0]);
  });
}

/**
 * Rename, recategorise, retire or bring back a code. The number is not
 * editable: reports match on it, and past dispositions carry it.
 */
export async function updateReasonCode(args: {
  orgId: string;
  userId: string;
  id: string;
  patch: { label?: string; category?: ReasonCategory; active?: boolean; sortOrder?: number };
}): Promise<ReasonCodeView> {
  return withOrgContext(args.orgId, async (tx) => {
    const p = args.patch;
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE org_reason_code SET
        label      = COALESCE(${p.label?.trim() ?? null}, label),
        category   = COALESCE(${p.category ?? null}, category),
        active     = COALESCE(${p.active ?? null}::boolean, active),
        sort_order = COALESCE(${p.sortOrder ?? null}::int, sort_order),
        updated_at = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      RETURNING id, kind, code, label, category, active, sort_order
    `;
    if (!rows[0]) throw new NotFoundError("Reason code not found.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "reason_code_change",
      targetType: "reason_code",
      targetId: rows[0].id,
      payload: {
        op: "update",
        kind: rows[0].kind,
        code: rows[0].code,
        fields: Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined),
      },
    });
    return toView(rows[0]);
  });
}
