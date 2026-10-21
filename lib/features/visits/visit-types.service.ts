/**
 * Org-owned visit types.
 *
 * Client walkthrough [02:30]: "agar koi visit type ho raha hai jo hum ne add
 * karna hai" — the org needs its own vocabulary for what a visit is.
 *
 * The catch: the visit type picks the base CPT band, so a free-form type would
 * silently change what gets billed. Every type therefore declares a
 * `codingBasis` — one of the built-in bands — and the CPT suggester keeps
 * branching on that closed set. The org names the encounter; the coder stays
 * deterministic.
 *
 * Telehealth is not a band (audit R22). A type can be flagged `isTelehealth`,
 * which forces every visit of that type onto the telehealth modality (95/93,
 * POS 10) while the band still comes from new vs established.
 *
 * "Not billed" is a band (audit R18): a type on `non_billable` is documented
 * and signed, and never billed. Inpatient consult is no longer offered, since
 * nothing can code it.
 *
 * Schema: db/migrations/0062_org_visit_types.sql, 0099_telehealth_is_modality.sql,
 * 0100_visit_type_non_billable.sql.
 */
import { z } from "zod";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { changedFieldNames, writeAudit } from "@/lib/features/audit/audit-write";
import { SELECTABLE_CODING_BASES, VISIT_TYPES, type VisitType } from "./visit.types";

export const CreateVisitTypeSchema = z.object({
  label: z.string().trim().min(2).max(64),
  // Not VISIT_TYPES: inpatient_consult has no code ladder, so a type on it
  // could never be signed (audit R18). Rows that already carry it keep it.
  codingBasis: z.enum(SELECTABLE_CODING_BASES),
  /** Every visit of this type is a telehealth visit. Never moves the band. */
  isTelehealth: z.boolean().default(false),
});
// z.input, not z.infer: isTelehealth is optional to callers, defaulted here.
export type CreateVisitType = z.input<typeof CreateVisitTypeSchema>;

export const UpdateVisitTypeSchema = z.object({
  label: z.string().trim().min(2).max(64).optional(),
  // A type can be moved off inpatient_consult, never onto it (audit R18).
  codingBasis: z.enum(SELECTABLE_CODING_BASES).optional(),
  isTelehealth: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateVisitType = z.infer<typeof UpdateVisitTypeSchema>;

export interface VisitTypeView {
  id: string;
  slug: string;
  label: string;
  codingBasis: VisitType;
  /** Visits of this type are always telehealth (audit R22). */
  isTelehealth: boolean;
  active: boolean;
  sortOrder: number;
  /** True for the seeded types every org starts with. */
  builtIn: boolean;
  /** How many visits use it; deactivating is safe, deleting isn't. */
  usageCount?: number;
}

interface Row {
  id: string;
  slug: string;
  label: string;
  coding_basis: VisitType;
  is_telehealth: boolean;
  active: boolean;
  sort_order: number;
  usage_count?: bigint;
}

function toView(r: Row): VisitTypeView {
  return {
    id: r.id,
    slug: r.slug,
    label: r.label,
    codingBasis: r.coding_basis,
    isTelehealth: r.is_telehealth,
    active: r.active,
    sortOrder: r.sort_order,
    builtIn: isBuiltInSlug(r.slug),
    ...(r.usage_count === undefined ? {} : { usageCount: Number(r.usage_count) }),
  };
}

/**
 * A seeded slug. Not only the coding bands: since audit R22 the seeded
 * 'telehealth' type is no longer a band, but it is still a built-in that a
 * custom type must not shadow.
 */
function isBuiltInSlug(slug: string): boolean {
  return (
    (VISIT_TYPES as readonly string[]).includes(slug) ||
    DEFAULT_VISIT_TYPES.some((t) => t.slug === slug)
  );
}

/** Turn a label into a slug that won't collide with the built-ins. */
export function slugifyVisitType(label: string): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "visit_type";
  // A custom type must never take a built-in slug, or it would shadow one.
  return isBuiltInSlug(base) ? `${base}_custom` : base;
}

export async function listVisitTypes(args: {
  orgId: string;
  includeInactive?: boolean;
}): Promise<VisitTypeView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    // The org is named as well as enforced by RLS, for the types and for the
    // visits counted against them: slugs repeat across orgs, so a count on
    // the slug alone added other orgs' visits on a connection that bypasses
    // RLS. Every selected column is grouped; usage_count stays bigint.
    const rows = await tx.$queryRaw<Row[]>`
      SELECT t.id, t.slug, t.label, t.coding_basis, t.is_telehealth, t.active, t.sort_order,
             COUNT(v.id)::bigint AS usage_count
      FROM org_visit_type t
      LEFT JOIN visit v ON v.org_id = t.org_id AND v.visit_type = t.slug
      WHERE t.org_id = ${args.orgId}::uuid
        AND (${args.includeInactive ?? false}::boolean OR t.active)
      GROUP BY t.id, t.slug, t.label, t.coding_basis, t.is_telehealth, t.active, t.sort_order
      ORDER BY t.sort_order, t.label
    `;
    return rows.map(toView);
  });
}

export async function createVisitType(args: {
  orgId: string;
  payload: CreateVisitType;
  /** Who did it — recorded on the audit trail. */
  actorUserId?: string | null;
}): Promise<{ id: string; slug: string }> {
  const slug = slugifyVisitType(args.payload.label);
  return withOrgContext(args.orgId, async (tx) => {
    // Both reads name the org as well as relying on RLS: another org's slug
    // is no clash here, and another org's sort order is not this list's end.
    const dupe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM org_visit_type
       WHERE org_id = ${args.orgId}::uuid AND lower(slug) = lower(${slug})
       LIMIT 1
    `;
    if (dupe[0]) {
      throw new ValidationError(`"${args.payload.label}" already exists.`);
    }
    const isTelehealth = args.payload.isTelehealth ?? false;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO org_visit_type (org_id, slug, label, coding_basis, is_telehealth, sort_order)
      VALUES (
        ${args.orgId}::uuid, ${slug}, ${args.payload.label}, ${args.payload.codingBasis},
        ${isTelehealth},
        COALESCE((SELECT MAX(sort_order) + 10 FROM org_visit_type WHERE org_id = ${args.orgId}::uuid), 100)
      )
      RETURNING id
    `;
    if (!rows[0]) throw new Error("createVisitType: insert returned no row.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.actorUserId ?? null,
      action: "settings_update",
      targetType: "visit_type",
      targetId: rows[0].id,
      payload: {
        change: "create",
        label: args.payload.label,
        codingBasis: args.payload.codingBasis,
        isTelehealth,
      },
    });
    return { id: rows[0].id, slug };
  });
}

export async function updateVisitType(args: {
  orgId: string;
  id: string;
  payload: UpdateVisitType;
  /** Who did it — recorded on the audit trail. */
  actorUserId?: string | null;
}): Promise<{ updated: boolean }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    // Deactivating the last usable type would leave scheduling with an empty
    // dropdown and no way back through the UI. This org's types only: another
    // org's active types are not this org's dropdown.
    if (p.active === false) {
      const remaining = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM org_visit_type
         WHERE org_id = ${args.orgId}::uuid AND active AND id <> ${args.id}::uuid
      `;
      if (Number(remaining[0]?.n ?? 0) === 0) {
        throw new ValidationError("Keep at least one active visit type.");
      }
    }
    const n = await tx.$executeRaw`
      UPDATE org_visit_type SET
        label = COALESCE(${p.label ?? null}, label),
        coding_basis = COALESCE(${p.codingBasis ?? null}, coding_basis),
        is_telehealth = COALESCE(${p.isTelehealth ?? null}::boolean, is_telehealth),
        active = COALESCE(${p.active ?? null}::boolean, active),
        updated_at = now()
      WHERE id = ${args.id}::uuid
        AND org_id = ${args.orgId}::uuid
    `;
    // Another org's type is not found, in the same words as a missing one.
    if (n === 0) throw new NotFoundError("Visit type not found.");
    // active is called out by name: switching one off removes it from the
    // scheduling dropdown for everybody, and that is the change worth being
    // able to attribute later.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.actorUserId ?? null,
      action: "settings_update",
      targetType: "visit_type",
      targetId: args.id,
      payload: {
        change: p.active === false ? "deactivate" : p.active === true ? "reactivate" : "edit",
        fields: changedFieldNames({
          label: p.label,
          codingBasis: p.codingBasis,
          isTelehealth: p.isTelehealth,
          active: p.active,
        }),
      },
    });
    return { updated: true };
  });
}

/**
 * Seeded into every new org so scheduling works on day one.
 *
 * slug and codingBasis are separate on purpose (audit R22). The 'telehealth'
 * type keeps its slug, so existing visits and the note template's telehealth
 * exemptions still resolve, but it bills on the established ladder with the
 * modality forced on. Signup used to insert the slug AS the band, which the
 * 0099 CHECK refuses — and a refused insert there fails every signup.
 */
export const DEFAULT_VISIT_TYPES: {
  slug: string;
  label: string;
  codingBasis: VisitType;
  isTelehealth: boolean;
  sortOrder: number;
}[] = [
  {
    slug: "new_patient_home",
    label: "New patient — home",
    codingBasis: "new_patient_home",
    isTelehealth: false,
    sortOrder: 10,
  },
  {
    slug: "established_patient_home",
    label: "Established patient — home",
    codingBasis: "established_patient_home",
    isTelehealth: false,
    sortOrder: 20,
  },
  {
    slug: "advance_care_planning",
    label: "Advance care planning",
    codingBasis: "advance_care_planning",
    isTelehealth: false,
    sortOrder: 30,
  },
  {
    slug: "telehealth",
    label: "Established patient — telehealth",
    codingBasis: "established_patient_home",
    isTelehealth: true,
    sortOrder: 40,
  },
  // No inpatient consult (audit R18): nothing can code it, so a new org would
  // start with a visit type whose visits can never be signed.
];
