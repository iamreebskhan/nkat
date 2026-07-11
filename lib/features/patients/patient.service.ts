/**
 * Patient service — multi-tenant CRUD against the `patient` table.
 *
 * Every read + write goes through `withOrgContext(orgId, fn)` so the
 * `app.current_org_id` GUC is set inside the transaction and RLS
 * policies fire correctly.
 *
 * Source schema: db/migrations/0029_phase_pallio_emr.sql.
 */
import { NotFoundError } from "@/lib/api";
import { prisma, withOrgContext } from "@/lib/db";
import type {
  CareTeam,
  CreatePatient,
  PatientStatus,
  PatientView,
  UpdateCareTeam,
  UpdatePatient,
} from "./patient.types";

/**
 * Validate that a payer UUID resolves to an existing row in the global
 * `payer` table. Surfaces a friendly error before the FK-violation 23503
 * would fire on INSERT. Used by createPatient + updatePatient.
 */
async function assertPayerExists(payerId: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM payer WHERE id = ${payerId}::uuid LIMIT 1
  `;
  if (!rows[0]) {
    throw new Error(
      `Unknown payer: ${payerId}. Pick one from /api/billing/payers.`,
    );
  }
}

/**
 * Every care-team assignee must be a member of the patient's org —
 * app_user is global, so a bare FK can't enforce tenancy. Runs inside
 * withOrgContext, so RLS scopes org_member to the current org. Surfaces
 * a friendly 422 instead of silently accepting a cross-tenant id.
 */
async function assertCareTeamMembers(
  tx: Parameters<Parameters<typeof withOrgContext>[1]>[0],
  careTeam: CareTeam | UpdateCareTeam | undefined,
): Promise<void> {
  const ids = [
    careTeam?.primaryNpUserId,
    careTeam?.rnUserId,
    careTeam?.socialWorkerUserId,
    careTeam?.billingAgentUserId,
  ].filter((v): v is string => typeof v === "string");
  if (ids.length === 0) return;
  // status = 'active' — invited/suspended/removed members can't be assigned.
  const found = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM org_member
    WHERE user_id = ANY(${ids}::uuid[]) AND status = 'active'
  `;
  const known = new Set(found.map((r) => r.user_id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Care-team assignee ${missing[0]} is not an active member of this organization.`,
    );
  }
}

/**
 * Persist a new patient. Caller must set `orgId` from the session.
 * `createdByUserId` is recorded for audit.
 */
export async function createPatient(args: {
  orgId: string;
  createdByUserId: string;
  payload: CreatePatient;
}): Promise<{ id: string }> {
  const { orgId, createdByUserId, payload } = args;
  const d = payload.demographics;
  const i = payload.insurance;
  const c = payload.clinical;
  const ct = payload.careTeam;

  if (i.primaryPayerId) await assertPayerExists(i.primaryPayerId);

  return withOrgContext(orgId, async (tx) => {
    await assertCareTeamMembers(tx, ct);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient (
        org_id, first_name, last_name, date_of_birth,
        sex_assigned_at_birth,
        address_line_1, address_line_2, city, state, zip,
        phone, emergency_contact_name, emergency_contact_phone,
        primary_payer_id, primary_member_id, primary_group_number,
        insurance_effective_date, insurance_termination_date,
        primary_diagnosis_icd10, referring_physician_npi,
        referring_physician_name, palliative_referral_reason,
        acuity, acuity_updated_at, acuity_updated_by_user_id,
        primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
        status, created_by_user_id
      ) VALUES (
        ${orgId}::uuid, ${d.firstName}, ${d.lastName}, ${d.dateOfBirth}::date,
        ${d.sexAssignedAtBirth ?? null},
        ${d.addressLine1 ?? null}, ${d.addressLine2 ?? null}, ${d.city ?? null}, ${d.state ?? null}, ${d.zip ?? null},
        ${d.phone ?? null}, ${d.emergencyContactName ?? null}, ${d.emergencyContactPhone ?? null},
        ${i.primaryPayerId ?? null}::uuid, ${i.primaryMemberId ?? null}, ${i.primaryGroupNumber ?? null},
        ${i.insuranceEffectiveDate ?? null}::date, ${i.insuranceTerminationDate ?? null}::date,
        ${c.primaryDiagnosisIcd10 ?? null}, ${c.referringPhysicianNpi ?? null},
        ${c.referringPhysicianName ?? null}, ${c.palliativeReferralReason ?? null},
        ${c.acuity ?? null},
        ${c.acuity ? new Date() : null},
        ${c.acuity ? createdByUserId : null}::uuid,
        ${ct?.primaryNpUserId ?? null}::uuid, ${ct?.rnUserId ?? null}::uuid,
        ${ct?.socialWorkerUserId ?? null}::uuid, ${ct?.billingAgentUserId ?? null}::uuid,
        'active', ${createdByUserId}::uuid
      )
      RETURNING id
    `;
    if (!rows[0]) throw new Error("createPatient: insert returned no row.");
    return { id: rows[0].id };
  });
}

interface PatientRow {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: Date;
  sex_assigned_at_birth: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  primary_payer_id: string | null;
  primary_member_id: string | null;
  primary_diagnosis_icd10: string | null;
  acuity: PatientView["acuity"];
  last_visit_date: Date | null;
  next_visit_date: Date | null;
  primary_np_user_id: string | null;
  rn_user_id: string | null;
  social_worker_user_id: string | null;
  billing_agent_user_id: string | null;
  /** Assignee display names — only the detail read (getPatient) resolves these. */
  primary_np_name?: string | null;
  rn_name?: string | null;
  social_worker_name?: string | null;
  billing_agent_name?: string | null;
  status: PatientStatus;
  created_at: Date;
  updated_at: Date;
}

function rowToView(row: PatientRow): PatientView {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    dateOfBirth: row.date_of_birth.toISOString().slice(0, 10),
    sexAssignedAtBirth: (row.sex_assigned_at_birth as PatientView["sexAssignedAtBirth"]) ?? null,
    addressLine1: row.address_line_1,
    city: row.city,
    state: row.state,
    zip: row.zip,
    phone: row.phone,
    primaryPayerId: row.primary_payer_id,
    primaryMemberId: row.primary_member_id,
    primaryDiagnosisIcd10: row.primary_diagnosis_icd10,
    acuity: row.acuity,
    lastVisitDate: row.last_visit_date ? row.last_visit_date.toISOString().slice(0, 10) : null,
    nextVisitDate: row.next_visit_date ? row.next_visit_date.toISOString().slice(0, 10) : null,
    careTeam: {
      primaryNp: { userId: row.primary_np_user_id, name: row.primary_np_name ?? null },
      rn: { userId: row.rn_user_id, name: row.rn_name ?? null },
      socialWorker: { userId: row.social_worker_user_id, name: row.social_worker_name ?? null },
      billingAgent: { userId: row.billing_agent_user_id, name: row.billing_agent_name ?? null },
    },
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getPatient(args: {
  orgId: string;
  id: string;
}): Promise<PatientView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<PatientRow[]>`
      SELECT patient.id, first_name, last_name, date_of_birth,
             sex_assigned_at_birth, address_line_1, city, patient.state, zip, phone,
             primary_payer_id, primary_member_id,
             primary_diagnosis_icd10, acuity,
             (SELECT MAX(COALESCE(v.start_time, v.scheduled_start)) FROM visit v
               WHERE v.patient_id = patient.id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT MIN(v.scheduled_start) FROM visit v
               WHERE v.patient_id = patient.id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             -- Seats survive offboarding (reassignment is a human decision),
             -- but the display must not pretend departed staff are current —
             -- flag any assignee whose org_member row is no longer active.
             CASE WHEN np.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.user_id = np.id AND om.status = 'active')
                    THEN COALESCE(np.full_name, np.email)
                  ELSE COALESCE(np.full_name, np.email) || ' (inactive)' END AS primary_np_name,
             CASE WHEN rn.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.user_id = rn.id AND om.status = 'active')
                    THEN COALESCE(rn.full_name, rn.email)
                  ELSE COALESCE(rn.full_name, rn.email) || ' (inactive)' END AS rn_name,
             CASE WHEN sw.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.user_id = sw.id AND om.status = 'active')
                    THEN COALESCE(sw.full_name, sw.email)
                  ELSE COALESCE(sw.full_name, sw.email) || ' (inactive)' END AS social_worker_name,
             CASE WHEN ba.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.user_id = ba.id AND om.status = 'active')
                    THEN COALESCE(ba.full_name, ba.email)
                  ELSE COALESCE(ba.full_name, ba.email) || ' (inactive)' END AS billing_agent_name,
             patient.status, patient.created_at, patient.updated_at
      FROM patient
      LEFT JOIN app_user np ON np.id = patient.primary_np_user_id
      LEFT JOIN app_user rn ON rn.id = patient.rn_user_id
      LEFT JOIN app_user sw ON sw.id = patient.social_worker_user_id
      LEFT JOIN app_user ba ON ba.id = patient.billing_agent_user_id
      WHERE patient.id = ${args.id}::uuid
      LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

export interface ListPatientsArgs {
  orgId: string;
  status?: PatientStatus;
  search?: string;
  payerId?: string;
  limit?: number;
  offset?: number;
}

export interface ListPatientsResult {
  rows: PatientView[];
  total: number;
}

export async function listPatients(
  args: ListPatientsArgs,
): Promise<ListPatientsResult> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const offset = Math.max(0, args.offset ?? 0);
  const status = args.status ?? "active";
  const searchPattern = args.search ? `%${args.search.toLowerCase()}%` : null;

  return withOrgContext(args.orgId, async (tx) => {
    // Two query paths to keep the SQL readable. Search is rare enough
    // that the duplication is cheaper than dynamic SQL composition.
    const rows = searchPattern
      ? await tx.$queryRaw<PatientRow[]>`
          SELECT id, first_name, last_name, date_of_birth,
                 sex_assigned_at_birth, address_line_1, city, state, zip, phone,
                 primary_payer_id, primary_member_id,
                 primary_diagnosis_icd10, acuity,
             (SELECT MAX(COALESCE(v.start_time, v.scheduled_start)) FROM visit v
               WHERE v.patient_id = patient.id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT MIN(v.scheduled_start) FROM visit v
               WHERE v.patient_id = patient.id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             status, created_at, updated_at
          FROM patient
          WHERE status = ${status}
            AND (
              lower(first_name) LIKE ${searchPattern}
              OR lower(last_name) LIKE ${searchPattern}
              OR lower(first_name || ' ' || last_name) LIKE ${searchPattern}
            )
          ORDER BY
            CASE acuity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                       WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC,
            last_name ASC, first_name ASC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await tx.$queryRaw<PatientRow[]>`
          SELECT id, first_name, last_name, date_of_birth,
                 sex_assigned_at_birth, address_line_1, city, state, zip, phone,
                 primary_payer_id, primary_member_id,
                 primary_diagnosis_icd10, acuity,
             (SELECT MAX(COALESCE(v.start_time, v.scheduled_start)) FROM visit v
               WHERE v.patient_id = patient.id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT MIN(v.scheduled_start) FROM visit v
               WHERE v.patient_id = patient.id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             status, created_at, updated_at
          FROM patient
          WHERE status = ${status}
          ORDER BY
            CASE acuity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                       WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC,
            last_name ASC, first_name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
    const totals = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM patient WHERE status = ${status}
    `;
    return {
      rows: rows.map(rowToView),
      total: Number(totals[0]?.n ?? 0),
    };
  });
}

/** Search variant — supports lowercase first/last/full name match. */
export async function searchPatients(args: {
  orgId: string;
  query: string;
  status?: PatientStatus;
  limit?: number;
}): Promise<PatientView[]> {
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const q = `%${args.query.toLowerCase()}%`;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<PatientRow[]>`
      SELECT id, first_name, last_name, date_of_birth,
             sex_assigned_at_birth, address_line_1, city, state, zip, phone,
             primary_payer_id, primary_member_id,
             primary_diagnosis_icd10, acuity,
             (SELECT MAX(COALESCE(v.start_time, v.scheduled_start)) FROM visit v
               WHERE v.patient_id = patient.id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT MIN(v.scheduled_start) FROM visit v
               WHERE v.patient_id = patient.id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             status, created_at, updated_at
      FROM patient
      WHERE (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
        AND (
          lower(first_name) LIKE ${q}
          OR lower(last_name) LIKE ${q}
          OR lower(first_name || ' ' || last_name) LIKE ${q}
        )
      ORDER BY last_name ASC, first_name ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToView);
  });
}

export async function updatePatient(args: {
  orgId: string;
  id: string;
  payload: UpdatePatient;
  /** Caller's user id — required for acuity audit columns. */
  userId?: string;
}): Promise<{ updated: boolean }> {
  // Only persist what's provided. We use a series of conditional UPDATE
  // statements rather than building one mega-UPDATE because Prisma's
  // tagged-template approach makes dynamic SET lists awkward, and
  // patient updates are infrequent enough that 2-3 round trips is fine.
  if (args.payload.insurance?.primaryPayerId) {
    await assertPayerExists(args.payload.insurance.primaryPayerId);
  }
  return withOrgContext(args.orgId, async (tx) => {
    // Existence check first — RLS filters out rows owned by another
    // org, so a missing row means "doesn't exist OR not yours". Both
    // surface as 404 (never leak cross-tenant existence).
    const exists = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient WHERE id = ${args.id}::uuid LIMIT 1
    `;
    if (exists.length === 0) throw new NotFoundError("Patient not found.");

    let touched = false;
    if (args.payload.demographics) {
      const d = args.payload.demographics;
      await tx.$executeRaw`
        UPDATE patient SET
          first_name = COALESCE(${d.firstName ?? null}, first_name),
          last_name  = COALESCE(${d.lastName ?? null},  last_name),
          date_of_birth = COALESCE(${d.dateOfBirth ?? null}::date, date_of_birth),
          updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }
    if (args.payload.insurance) {
      const i = args.payload.insurance;
      await tx.$executeRaw`
        UPDATE patient SET
          primary_payer_id   = COALESCE(${i.primaryPayerId ?? null}::uuid, primary_payer_id),
          primary_member_id  = COALESCE(${i.primaryMemberId ?? null},     primary_member_id),
          primary_group_number = COALESCE(${i.primaryGroupNumber ?? null}, primary_group_number),
          insurance_effective_date  = COALESCE(${i.insuranceEffectiveDate ?? null}::date, insurance_effective_date),
          insurance_termination_date = COALESCE(${i.insuranceTerminationDate ?? null}::date, insurance_termination_date),
          updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }
    if (args.payload.clinical) {
      const c = args.payload.clinical;
      await tx.$executeRaw`
        UPDATE patient SET
          primary_diagnosis_icd10 = COALESCE(${c.primaryDiagnosisIcd10 ?? null}, primary_diagnosis_icd10),
          referring_physician_npi = COALESCE(${c.referringPhysicianNpi ?? null}, referring_physician_npi),
          referring_physician_name = COALESCE(${c.referringPhysicianName ?? null}, referring_physician_name),
          palliative_referral_reason = COALESCE(${c.palliativeReferralReason ?? null}, palliative_referral_reason),
          acuity = COALESCE(${c.acuity ?? null}, acuity),
          acuity_updated_at = CASE WHEN ${c.acuity ?? null}::text IS NULL THEN acuity_updated_at ELSE now() END,
          acuity_updated_by_user_id = CASE WHEN ${c.acuity ?? null}::text IS NULL THEN acuity_updated_by_user_id ELSE ${args.userId ?? null}::uuid END,
          updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }
    if (args.payload.careTeam && Object.keys(args.payload.careTeam).length > 0) {
      const ct = args.payload.careTeam;
      await assertCareTeamMembers(tx, ct);
      // Tri-state per seat: absent = keep, null = unassign, uuid = reassign.
      // COALESCE can't express "explicit null clears", so each CASE is driven
      // by a JS-side "was the field provided" boolean.
      await tx.$executeRaw`
        UPDATE patient SET
          primary_np_user_id    = CASE WHEN ${ct.primaryNpUserId === undefined} THEN primary_np_user_id    ELSE ${ct.primaryNpUserId ?? null}::uuid END,
          rn_user_id            = CASE WHEN ${ct.rnUserId === undefined} THEN rn_user_id            ELSE ${ct.rnUserId ?? null}::uuid END,
          social_worker_user_id = CASE WHEN ${ct.socialWorkerUserId === undefined} THEN social_worker_user_id ELSE ${ct.socialWorkerUserId ?? null}::uuid END,
          billing_agent_user_id = CASE WHEN ${ct.billingAgentUserId === undefined} THEN billing_agent_user_id ELSE ${ct.billingAgentUserId ?? null}::uuid END,
          updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }
    if (args.payload.status) {
      await tx.$executeRaw`
        UPDATE patient SET status = ${args.payload.status}, updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }
    return { updated: touched };
  });
}
