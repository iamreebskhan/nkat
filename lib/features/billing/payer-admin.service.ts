/**
 * The payer roster, edited by a platform operator (audit R17).
 *
 * WHY THIS EXISTS. The roster changed only through a seed file and a deploy;
 * nothing in app/ or lib/ ran INSERT INTO payer. A client in a fourth state,
 * or one billing a plan we had not listed — any Medicare Advantage plan, the
 * main managed line for a Medicare-age palliative caseload — could not pick
 * the patient's payer at intake, so those patients got no coverage rules and
 * no denial prediction. A retired plan could not be withdrawn either.
 *
 * NOTHING IS SEEDED FROM HERE. A payer is added when a client names it, with
 * its ingestion source or through analyst attestation, so the roster never
 * carries invented plans.
 *
 * The routes gate on platform_admin. `payer` is global reference data with no
 * RLS (0007_rls.sql) and the app role holds DML on it (0052), but each write
 * still runs inside withOrgContext(orgId): audit_log needs an org, and the
 * audit row must commit with the change or not at all.
 */
import { z } from "zod";

import { NotFoundError, ValidationError } from "@/lib/api";
import { prisma, withOrgContext } from "@/lib/db";
import { changedFieldNames, writeAudit } from "@/lib/features/audit/audit-write";

import { PAYER_TYPES, type PayerType } from "./payer-types";
import { PROLONGED_SERVICE_CODES, type ProlongedServiceCode } from "./prolonged-code";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** Uppercased and de-duplicated, first-seen order kept. */
const StatesServedSchema = z
  .array(z.string().regex(/^[A-Za-z]{2}$/, "Use 2-letter USPS state codes."))
  .min(1, "Pick at least one state.")
  .transform((xs) => Array.from(new Set(xs.map((s) => s.toUpperCase()))));

export const PayerInputSchema = z.object({
  name: z.string().trim().min(2).max(150),
  parentOrg: z.string().trim().max(120).optional(),
  payerType: z.enum(PAYER_TYPES),
  statesServed: StatesServedSchema,
  policyIndexUrl: z.string().trim().url().max(2000).optional(),
  externalPayerId: z.string().trim().max(64).optional(),
  notes: z.string().max(2000).optional(),
  /**
   * The prolonged-service add-on this payer takes (0108). Absent or null: by
   * payer type, G0318 for Medicare and Medicare Advantage, 99417 otherwise.
   */
  prolongedServiceCode: z.enum(PROLONGED_SERVICE_CODES).nullable().optional(),
});
export type PayerInput = z.infer<typeof PayerInputSchema>;

export const UpdatePayerSchema = PayerInputSchema.partial()
  .extend({
    // Clearable on edit: null clears the column, absent leaves it alone.
    parentOrg: z.string().trim().max(120).nullable().optional(),
    policyIndexUrl: z.string().trim().url().max(2000).nullable().optional(),
    externalPayerId: z.string().trim().max(64).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    /** false withdraws the payer from every picker. Nothing is deleted. */
    active: z.boolean().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "Nothing to change.",
  });
export type UpdatePayerInput = z.infer<typeof UpdatePayerSchema>;

export interface AdminPayerView {
  id: string;
  name: string;
  parentOrg: string | null;
  payerType: PayerType;
  statesServed: string[];
  policyIndexUrl: string | null;
  externalPayerId: string | null;
  notes: string | null;
  /** Set where the payer takes the other code than its type would; null = by type. */
  prolongedServiceCode: ProlongedServiceCode | null;
  active: boolean;
  /**
   * Live payer_rule rows per state. A state in statesServed with no entry here
   * is one the payer is listed for but Pallio cannot answer for.
   */
  liveRules: Record<string, number>;
  createdAt: string;
}

interface Row {
  id: string;
  name: string;
  parent_org: string | null;
  payer_type: PayerType;
  states_served: string[] | null;
  policy_index_url: string | null;
  external_payer_id: string | null;
  notes: string | null;
  prolonged_service_code: ProlongedServiceCode | null;
  active: boolean;
  created_at: Date;
  live_rules: Record<string, number> | null;
}

function toView(r: Row): AdminPayerView {
  return {
    id: r.id,
    name: r.name,
    parentOrg: r.parent_org,
    payerType: r.payer_type,
    statesServed: r.states_served ?? [],
    policyIndexUrl: r.policy_index_url,
    externalPayerId: r.external_payer_id,
    notes: r.notes,
    prolongedServiceCode: r.prolonged_service_code,
    active: r.active,
    liveRules: r.live_rules ?? {},
    createdAt: r.created_at.toISOString(),
  };
}

/** One payer (id) or the whole roster (null), inactive rows included. */
async function readPayers(
  db: Pick<Tx, "$queryRaw">,
  id: string | null,
): Promise<AdminPayerView[]> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT p.id, p.name::text AS name, p.parent_org, p.payer_type, p.states_served,
           p.policy_index_url, p.external_payer_id, p.notes, p.prolonged_service_code,
           p.active, p.created_at,
           COALESCE((
             SELECT jsonb_object_agg(s.state, s.n)
               FROM (SELECT pr.state::text AS state, count(*)::int AS n
                       FROM payer_rule pr
                      WHERE pr.payer_id = p.id AND pr.expiration_date IS NULL
                      GROUP BY pr.state) s
           ), '{}'::jsonb) AS live_rules
      FROM payer p
     WHERE (${id}::uuid IS NULL OR p.id = ${id}::uuid)
     ORDER BY p.active DESC, p.name ASC
  `;
  return rows.map(toView);
}

export async function listPayersForAdmin(): Promise<AdminPayerView[]> {
  return readPayers(prisma, null);
}

/**
 * Serialise roster writes. payer.name has no unique index, so two operators
 * adding the same plan at once could both pass the duplicate check. The lock
 * is transaction-scoped and only other roster writes wait on it.
 */
async function lockRoster(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payer_roster'))`;
}

/** Every code must be a row of the `state` reference table (all 56 are). */
async function assertStatesKnown(tx: Tx, states: string[]): Promise<void> {
  const rows = await tx.$queryRaw<{ state: string }[]>`
    SELECT state::text AS state FROM state WHERE state = ANY(${states}::text[])
  `;
  const known = new Set(rows.map((r) => r.state));
  const unknown = states.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown state code(s): ${unknown.join(", ")}.`);
  }
}

/** payer.name is CITEXT, so "aetna" and "Aetna" are the same payer. */
async function assertNameFree(tx: Tx, name: string, exceptId: string | null): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payer WHERE name = ${name}::citext
       AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)
     LIMIT 1
  `;
  if (rows[0]) {
    throw new ValidationError(
      `A payer named "${name}" already exists — edit its states, or reactivate it, instead.`,
    );
  }
}

/** The audit row names the DB columns touched, never their values. */
const COLUMN: Record<string, string> = {
  parentOrg: "parent_org",
  payerType: "payer_type",
  statesServed: "states_served",
  policyIndexUrl: "policy_index_url",
  externalPayerId: "external_payer_id",
  prolongedServiceCode: "prolonged_service_code",
};
const fieldNames = (patch: Record<string, unknown>) =>
  changedFieldNames(patch).map((k) => COLUMN[k] ?? k);

export async function createPayer(args: {
  orgId: string;
  userId: string;
  input: PayerInput;
}): Promise<AdminPayerView> {
  const i = args.input;
  return withOrgContext(args.orgId, async (tx) => {
    await lockRoster(tx);
    await assertStatesKnown(tx, i.statesServed);
    await assertNameFree(tx, i.name, null);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO payer (
        name, parent_org, payer_type, states_served,
        policy_index_url, external_payer_id, notes, prolonged_service_code
      ) VALUES (
        ${i.name}, ${i.parentOrg || null}, ${i.payerType}, ${i.statesServed}::char(2)[],
        ${i.policyIndexUrl || null}, ${i.externalPayerId || null}, ${i.notes || null},
        ${i.prolongedServiceCode ?? null}
      )
      RETURNING id
    `;
    const id = rows[0]!.id;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "payer_roster_change",
      targetType: "payer",
      targetId: id,
      payload: {
        op: "create",
        name: i.name,
        payerType: i.payerType,
        fields: fieldNames(i),
        statesServed: i.statesServed,
        ...(i.prolongedServiceCode ? { prolongedServiceCode: i.prolongedServiceCode } : {}),
      },
    });
    return (await readPayers(tx, id))[0]!;
  });
}

export async function updatePayer(args: {
  orgId: string;
  userId: string;
  id: string;
  patch: UpdatePayerInput;
}): Promise<AdminPayerView> {
  const p = args.patch;
  return withOrgContext(args.orgId, async (tx) => {
    await lockRoster(tx);
    if (p.statesServed) await assertStatesKnown(tx, p.statesServed);
    if (p.name) await assertNameFree(tx, p.name, args.id);
    const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
      UPDATE payer SET
        name              = COALESCE(${p.name ?? null}::citext, name),
        parent_org        = CASE WHEN ${p.parentOrg === undefined}
                                 THEN parent_org ELSE ${p.parentOrg || null} END,
        payer_type        = COALESCE(${p.payerType ?? null}, payer_type),
        states_served     = COALESCE(${p.statesServed ?? null}::char(2)[], states_served),
        policy_index_url  = CASE WHEN ${p.policyIndexUrl === undefined}
                                 THEN policy_index_url ELSE ${p.policyIndexUrl || null} END,
        external_payer_id = CASE WHEN ${p.externalPayerId === undefined}
                                 THEN external_payer_id ELSE ${p.externalPayerId || null} END,
        notes             = CASE WHEN ${p.notes === undefined}
                                 THEN notes ELSE ${p.notes || null} END,
        prolonged_service_code = CASE WHEN ${p.prolongedServiceCode === undefined}
                                 THEN prolonged_service_code ELSE ${p.prolongedServiceCode ?? null} END,
        active            = COALESCE(${p.active ?? null}::boolean, active)
      WHERE id = ${args.id}::uuid
      RETURNING id, name::text AS name
    `;
    if (!rows[0]) throw new NotFoundError("Payer not found.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "payer_roster_change",
      targetType: "payer",
      targetId: args.id,
      payload: {
        op: "update",
        name: rows[0].name,
        fields: fieldNames(p),
        ...(p.statesServed ? { statesServed: p.statesServed } : {}),
        ...(p.active !== undefined ? { active: p.active } : {}),
        // A closed set (G0318, 99417, or back to the default), like active.
        ...(p.prolongedServiceCode !== undefined ? { prolongedServiceCode: p.prolongedServiceCode } : {}),
      },
    });
    return (await readPayers(tx, args.id))[0]!;
  });
}
