/**
 * Org-owned visit types.
 *
 * Client walkthrough [02:30]: "agar koi visit type ho raha hai jo hum ne add
 * karna hai" — the org needs its own vocabulary for what a visit is.
 *
 * The catch: the visit type picks the base CPT band, so a free-form type would
 * silently change what gets billed. Every type therefore declares a
 * `codingBasis` — one of the five built-in bands — and the CPT suggester keeps
 * branching on that closed set. The org names the encounter; the coder stays
 * deterministic.
 *
 * Schema: db/migrations/0062_org_visit_types.sql.
 */
import { z } from "zod";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { changedFieldNames, writeAudit } from "@/lib/features/audit/audit-write";
import { VISIT_TYPES, type VisitType } from "./visit.types";

export const CreateVisitTypeSchema = z.object({
  label: z.string().trim().min(2).max(64),
  codingBasis: z.enum(VISIT_TYPES),
});
export type CreateVisitType = z.infer<typeof CreateVisitTypeSchema>;

export const UpdateVisitTypeSchema = z.object({
  label: z.string().trim().min(2).max(64).optional(),
  codingBasis: z.enum(VISIT_TYPES).optional(),
  active: z.boolean().optional(),
});
export type UpdateVisitType = z.infer<typeof UpdateVisitTypeSchema>;

export interface VisitTypeView {
  id: string;
  slug: string;
  label: string;
  codingBasis: VisitType;
  active: boolean;
  sortOrder: number;
  /** True for the five seeded types — their slug IS a coding basis. */
  builtIn: boolean;
  /** How many visits use it; deactivating is safe, deleting isn't. */
  usageCount?: number;
}

interface Row {
  id: string;
  slug: string;
  label: string;
  coding_basis: VisitType;
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
    active: r.active,
    sortOrder: r.sort_order,
    builtIn: (VISIT_TYPES as readonly string[]).includes(r.slug),
    ...(r.usage_count === undefined ? {} : { usageCount: Number(r.usage_count) }),
  };
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
  return (VISIT_TYPES as readonly string[]).includes(base) ? `${base}_custom` : base;
}

export async function listVisitTypes(args: {
  orgId: string;
  includeInactive?: boolean;
}): Promise<VisitTypeView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT t.id, t.slug, t.label, t.coding_basis, t.active, t.sort_order,
             (SELECT COUNT(*)::bigint FROM visit v WHERE v.visit_type = t.slug)
               AS usage_count
      FROM org_visit_type t
      WHERE (${args.includeInactive ?? false}::boolean OR t.active)
      ORDER BY t.sort_order, t.label
    `;
    return rows.map(toView);
  });
}

/**
 * Resolve a visit-type slug to the band the CPT suggester understands.
 * Throws when the slug isn't one of the org's active types, which is what
 * keeps visit.visit_type trustworthy now that the DB CHECK is gone.
 */
export async function resolveCodingBasis(args: {
  orgId: string;
  slug: string;
}): Promise<VisitType> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ coding_basis: VisitType }[]>`
      SELECT coding_basis FROM org_visit_type
       WHERE slug = ${args.slug} AND active
       LIMIT 1
    `;
    if (!rows[0]) {
      throw new ValidationError(`"${args.slug}" is not one of your visit types.`);
    }
    return rows[0].coding_basis;
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
    const dupe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM org_visit_type WHERE lower(slug) = lower(${slug}) LIMIT 1
    `;
    if (dupe[0]) {
      throw new ValidationError(`"${args.payload.label}" already exists.`);
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO org_visit_type (org_id, slug, label, coding_basis, sort_order)
      VALUES (
        ${args.orgId}::uuid, ${slug}, ${args.payload.label}, ${args.payload.codingBasis},
        COALESCE((SELECT MAX(sort_order) + 10 FROM org_visit_type), 100)
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
      payload: { change: "create", label: args.payload.label, codingBasis: args.payload.codingBasis },
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
    // dropdown and no way back through the UI.
    if (p.active === false) {
      const remaining = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM org_visit_type
         WHERE active AND id <> ${args.id}::uuid
      `;
      if (Number(remaining[0]?.n ?? 0) === 0) {
        throw new ValidationError("Keep at least one active visit type.");
      }
    }
    const n = await tx.$executeRaw`
      UPDATE org_visit_type SET
        label = COALESCE(${p.label ?? null}, label),
        coding_basis = COALESCE(${p.codingBasis ?? null}, coding_basis),
        active = COALESCE(${p.active ?? null}::boolean, active),
        updated_at = now()
      WHERE id = ${args.id}::uuid
    `;
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
        fields: changedFieldNames({ label: p.label, codingBasis: p.codingBasis, active: p.active }),
      },
    });
    return { updated: true };
  });
}

/** Seeded into every new org so scheduling works on day one. */
export const DEFAULT_VISIT_TYPES: {
  slug: VisitType;
  label: string;
  sortOrder: number;
}[] = [
  { slug: "new_patient_home", label: "New patient — home", sortOrder: 10 },
  { slug: "established_patient_home", label: "Established patient — home", sortOrder: 20 },
  { slug: "advance_care_planning", label: "Advance care planning", sortOrder: 30 },
  { slug: "telehealth", label: "Telehealth", sortOrder: 40 },
  { slug: "inpatient_consult", label: "Inpatient consult", sortOrder: 50 },
];
