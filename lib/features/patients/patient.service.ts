/**
 * Patient service — multi-tenant CRUD against the `patient` table.
 *
 * Every read + write goes through `withOrgContext(orgId, fn)` so the
 * `app.current_org_id` GUC is set inside the transaction and RLS
 * policies fire correctly.
 *
 * Source schema: db/migrations/0029_phase_pallio_emr.sql.
 */
import { withOrgContext } from "@/lib/db";
import type {
  CreatePatient,
  PatientStatus,
  PatientView,
  UpdatePatient,
} from "./patient.types";

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

  return withOrgContext(orgId, async (tx) => {
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
      SELECT id, first_name, last_name, date_of_birth,
             sex_assigned_at_birth, address_line_1, city, state, zip, phone,
             primary_payer_id, primary_member_id,
             primary_diagnosis_icd10, status, created_at, updated_at
      FROM patient
      WHERE id = ${args.id}::uuid
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
                 primary_diagnosis_icd10, status, created_at, updated_at
          FROM patient
          WHERE status = ${status}
            AND (
              lower(first_name) LIKE ${searchPattern}
              OR lower(last_name) LIKE ${searchPattern}
              OR lower(first_name || ' ' || last_name) LIKE ${searchPattern}
            )
          ORDER BY last_name ASC, first_name ASC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await tx.$queryRaw<PatientRow[]>`
          SELECT id, first_name, last_name, date_of_birth,
                 sex_assigned_at_birth, address_line_1, city, state, zip, phone,
                 primary_payer_id, primary_member_id,
                 primary_diagnosis_icd10, status, created_at, updated_at
          FROM patient
          WHERE status = ${status}
          ORDER BY last_name ASC, first_name ASC
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
  limit?: number;
}): Promise<PatientView[]> {
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const q = `%${args.query.toLowerCase()}%`;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<PatientRow[]>`
      SELECT id, first_name, last_name, date_of_birth,
             sex_assigned_at_birth, address_line_1, city, state, zip, phone,
             primary_payer_id, primary_member_id,
             primary_diagnosis_icd10, status, created_at, updated_at
      FROM patient
      WHERE status = 'active'
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
}): Promise<{ updated: boolean }> {
  // Only persist what's provided. We use a series of conditional UPDATE
  // statements rather than building one mega-UPDATE because Prisma's
  // tagged-template approach makes dynamic SET lists awkward, and
  // patient updates are infrequent enough that 2-3 round trips is fine.
  return withOrgContext(args.orgId, async (tx) => {
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
