/**
 * Visit services — the org's catalog, and what was provided on a visit.
 *
 * Client walkthrough [02:28–02:47]: against a visit, record which services
 * were actually provided — what help was given, what was handed over.
 *
 * Schema: db/migrations/0060_visit_services.sql. Every read and write is
 * tenant-scoped through withOrgContext.
 */
import { z } from "zod";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";

export const SERVICE_CATEGORIES = [
  "clinical",
  "psychosocial",
  "care_coordination",
  "education",
  "other",
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const CreateServiceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  // Optional rather than .default() — a Zod default makes the schema's input
  // and output types diverge, and parseJson infers the input side.
  category: z.enum(SERVICE_CATEGORIES).optional(),
  cptHint: z.string().trim().max(10).optional(),
  /** Visit-type slugs this applies to. Omitted/empty = every type. */
  visitTypes: z.array(z.string().trim().min(2).max(64)).max(20).optional(),
});
export type CreateService = z.infer<typeof CreateServiceSchema>;

export const UpdateServiceSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  category: z.enum(SERVICE_CATEGORIES).optional(),
  cptHint: z.string().trim().max(10).nullable().optional(),
  visitTypes: z.array(z.string().trim().min(2).max(64)).max(20).optional(),
  active: z.boolean().optional(),
});
export type UpdateService = z.infer<typeof UpdateServiceSchema>;

/** What the clinician ticked on a visit, with optional minutes and a note. */
export const SetVisitServicesSchema = z.object({
  services: z
    .array(
      z.object({
        serviceId: z.string().uuid(),
        minutes: z.number().int().min(0).max(720).nullable().optional(),
        note: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .max(50),
});
export type SetVisitServices = z.infer<typeof SetVisitServicesSchema>;

/**
 * Starter catalog for a brand-new org, so the picker isn't empty on day one.
 * Mirrors the seed in 0060 — that migration covers orgs that already existed;
 * this covers every org created after it. Orgs rename, deactivate and extend
 * these freely.
 */
export const DEFAULT_VISIT_SERVICES: {
  name: string;
  description: string;
  category: ServiceCategory;
  cptHint: string | null;
  sortOrder: number;
}[] = [
  { name: "Symptom management",        description: "Pain, dyspnea, nausea, or other symptom assessment and treatment", category: "clinical",          cptHint: null,    sortOrder: 10 },
  { name: "Medication reconciliation", description: "Full medication review, deprescribing, adherence check",           category: "clinical",          cptHint: null,    sortOrder: 20 },
  { name: "Wound care",                description: "Assessment and dressing of pressure injuries or wounds",           category: "clinical",          cptHint: null,    sortOrder: 30 },
  { name: "Advance care planning",     description: "Goals-of-care discussion, POLST/MOLST, surrogate designation",     category: "psychosocial",      cptHint: "99497", sortOrder: 40 },
  { name: "Psychosocial support",      description: "Emotional support for the patient; anxiety, depression, distress", category: "psychosocial",      cptHint: null,    sortOrder: 50 },
  { name: "Caregiver education",       description: "Teaching the family how to provide care between visits",           category: "education",         cptHint: null,    sortOrder: 60 },
  { name: "Equipment/DME assessment",  description: "Hospital bed, oxygen, mobility aids — need and ordering",          category: "care_coordination", cptHint: null,    sortOrder: 70 },
  { name: "Referral coordination",     description: "Hospice, home health, specialist, or community-service referral",  category: "care_coordination", cptHint: null,    sortOrder: 80 },
  { name: "Nutrition support",         description: "Appetite, intake, feeding decisions",                              category: "clinical",          cptHint: null,    sortOrder: 90 },
  { name: "Spiritual care referral",   description: "Chaplaincy or the patient's own faith community",                  category: "psychosocial",      cptHint: null,    sortOrder: 100 },
];

export interface VisitServiceView {
  id: string;
  name: string;
  description: string | null;
  category: ServiceCategory;
  cptHint: string | null;
  active: boolean;
  sortOrder: number;
  /** Visit-type slugs it applies to; empty = every type. */
  visitTypes: string[];
  /** How many visits reference it — deactivating is safe, deleting isn't. */
  usageCount?: number;
}

export interface ProvidedServiceView {
  serviceId: string;
  name: string;
  category: ServiceCategory;
  cptHint: string | null;
  minutes: number | null;
  note: string | null;
}

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  category: ServiceCategory;
  cpt_hint: string | null;
  active: boolean;
  sort_order: number;
  visit_types: string[] | null;
  usage_count?: bigint;
}

function toView(r: CatalogRow): VisitServiceView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    cptHint: r.cpt_hint,
    active: r.active,
    sortOrder: r.sort_order,
    visitTypes: r.visit_types ?? [],
    ...(r.usage_count === undefined ? {} : { usageCount: Number(r.usage_count) }),
  };
}

export async function listServiceCatalog(args: {
  orgId: string;
  includeInactive?: boolean;
  /** Narrow to services that apply to this visit-type slug. */
  visitType?: string;
}): Promise<VisitServiceView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<CatalogRow[]>`
      SELECT s.id, s.name, s.description, s.category, s.cpt_hint, s.active,
             s.sort_order, s.visit_types,
             (SELECT COUNT(*)::bigint FROM visit_service_provided p WHERE p.service_id = s.id)
               AS usage_count
      FROM visit_service s
      WHERE (${args.includeInactive ?? false}::boolean OR s.active)
        -- Empty visit_types = applies to every type, which is how everything
        -- seeded by 0060 behaves. Client walkthrough 02:34: different visit
        -- types carry different services.
        AND (
          ${args.visitType ?? null}::text IS NULL
          OR cardinality(s.visit_types) = 0
          OR ${args.visitType ?? null}::text = ANY(s.visit_types)
        )
      ORDER BY s.sort_order, s.name
    `;
    return rows.map(toView);
  });
}

export async function createService(args: {
  orgId: string;
  payload: CreateService;
}): Promise<{ id: string }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    // The unique index is case-insensitive; check first so the user gets a
    // clear 422 instead of a raw constraint violation.
    const dupe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visit_service WHERE lower(name) = lower(${p.name}) LIMIT 1
    `;
    if (dupe[0]) throw new ValidationError(`"${p.name}" is already in the catalog.`);

    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO visit_service (
        org_id, name, description, category, cpt_hint, visit_types, sort_order
      )
      VALUES (
        ${args.orgId}::uuid, ${p.name}, ${p.description ?? null},
        ${p.category ?? "clinical"}, ${p.cptHint ?? null},
        ${p.visitTypes ?? []}::text[],
        -- New entries land at the end of the picker.
        COALESCE((SELECT MAX(sort_order) + 10 FROM visit_service), 100)
      )
      RETURNING id
    `;
    if (!rows[0]) throw new Error("createService: insert returned no row.");
    return { id: rows[0].id };
  });
}

export async function updateService(args: {
  orgId: string;
  id: string;
  payload: UpdateService;
}): Promise<{ updated: boolean }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    if (p.name) {
      const dupe = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM visit_service
         WHERE lower(name) = lower(${p.name}) AND id <> ${args.id}::uuid
         LIMIT 1
      `;
      if (dupe[0]) throw new ValidationError(`"${p.name}" is already in the catalog.`);
    }
    const n = await tx.$executeRaw`
      UPDATE visit_service SET
        name = COALESCE(${p.name ?? null}, name),
        description = CASE WHEN ${p.description !== undefined}::boolean
                           THEN ${p.description ?? null} ELSE description END,
        category = COALESCE(${p.category ?? null}, category),
        cpt_hint = CASE WHEN ${p.cptHint !== undefined}::boolean
                        THEN ${p.cptHint ?? null} ELSE cpt_hint END,
        visit_types = COALESCE(${p.visitTypes ?? null}::text[], visit_types),
        active = COALESCE(${p.active ?? null}::boolean, active),
        updated_at = now()
      WHERE id = ${args.id}::uuid
    `;
    if (n === 0) throw new NotFoundError("Service not found.");
    return { updated: true };
  });
}

export async function listVisitServices(args: {
  orgId: string;
  visitId: string;
}): Promise<ProvidedServiceView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        service_id: string;
        name: string;
        category: ServiceCategory;
        cpt_hint: string | null;
        minutes: number | null;
        note: string | null;
      }[]
    >`
      SELECT p.service_id, s.name, s.category, s.cpt_hint, p.minutes, p.note
      FROM visit_service_provided p
      JOIN visit_service s ON s.id = p.service_id
      WHERE p.visit_id = ${args.visitId}::uuid
      ORDER BY s.sort_order, s.name
    `;
    return rows.map((r) => ({
      serviceId: r.service_id,
      name: r.name,
      category: r.category,
      cptHint: r.cpt_hint,
      minutes: r.minutes,
      note: r.note,
    }));
  });
}

/**
 * Replace the set of services on a visit. Whole-set replacement (not a diff)
 * so an unticked box actually removes the service — a merge would make
 * un-recording something impossible.
 */
export async function setVisitServices(args: {
  orgId: string;
  visitId: string;
  payload: SetVisitServices;
}): Promise<{ count: number }> {
  const items = args.payload.services;
  return withOrgContext(args.orgId, async (tx) => {
    const visit = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visit WHERE id = ${args.visitId}::uuid LIMIT 1
    `;
    if (!visit[0]) throw new NotFoundError("Visit not found.");

    if (items.length > 0) {
      // Reject ids from outside this org's catalog (or already deactivated)
      // before writing anything.
      const ids = items.map((i) => i.serviceId);
      const known = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM visit_service
         WHERE id = ANY(${ids}::uuid[])
           AND (
             active
             -- A service deactivated after it was already recorded on this
             -- visit must stay saveable, or every later save 422s and the
             -- clinician can't even untick it.
             OR id IN (
               SELECT service_id FROM visit_service_provided
                WHERE visit_id = ${args.visitId}::uuid
             )
           )
      `;
      const knownSet = new Set(known.map((k) => k.id));
      const unknown = ids.filter((i) => !knownSet.has(i));
      if (unknown.length > 0) {
        throw new ValidationError("One or more services are not in your catalog.");
      }
    }

    await tx.$executeRaw`
      DELETE FROM visit_service_provided WHERE visit_id = ${args.visitId}::uuid
    `;
    for (const i of items) {
      await tx.$executeRaw`
        INSERT INTO visit_service_provided (visit_id, service_id, org_id, minutes, note)
        VALUES (
          ${args.visitId}::uuid, ${i.serviceId}::uuid, ${args.orgId}::uuid,
          ${i.minutes ?? null}, ${i.note ?? null}
        )
        ON CONFLICT (visit_id, service_id) DO UPDATE
          SET minutes = EXCLUDED.minutes, note = EXCLUDED.note
      `;
    }
    return { count: items.length };
  });
}
