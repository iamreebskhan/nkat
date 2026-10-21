/**
 * Patient service — multi-tenant CRUD against the `patient` table.
 *
 * Every read + write goes through `withOrgContext(orgId, fn)` so the
 * `app.current_org_id` GUC is set inside the transaction and RLS
 * policies fire correctly.
 *
 * Source schema: db/migrations/0029_phase_pallio_emr.sql.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { dateColumnIso } from "@/lib/features/org/org-date";
import { applyPhiKeyIfConfigured } from "@/lib/hipaa/pgp";

import { insertContactRow } from "./contacts.service";
import { insertPatientProviderLink, resolveOrCreateProvider } from "./external-providers.service";
import { checkCoveragePair } from "./insurance-pure";
import type {
  CareTeam,
  CreatePatient,
  PatientStatus,
  PatientView,
  UpdateCareTeam,
  UpdatePatient,
} from "./patient.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/**
 * The payer exists AND covers the coverage state (audit R37).
 *
 * This only checked that the payer existed. Every rule lookup and the denial
 * predictor key on (payer, state), so a pair outside the payer's
 * states_served (CareSource Ohio with UT) could never resolve, and rendered
 * as "unknown coverage" instead of being refused at the door. Runs inside the
 * caller's transaction; payer and state are global reference tables.
 */
async function assertCoveragePair(tx: Tx, payerId: string, state: string | null): Promise<void> {
  const rows = await tx.$queryRaw<{ name: string; states_served: string[] | null }[]>`
    SELECT name, states_served FROM payer WHERE id = ${payerId}::uuid LIMIT 1
  `;
  const payer = rows[0];
  if (!payer) {
    throw new ValidationError(`Unknown payer: ${payerId}. Pick one from /api/billing/payers.`);
  }
  if (state) await assertStateKnown(tx, state);
  const problem = checkCoveragePair(
    { name: payer.name, statesServed: payer.states_served ?? [] },
    state,
  );
  if (problem) throw new ValidationError(problem);
}

/** Two letters that are not a state: the schema only ever checked the shape. */
async function assertStateKnown(tx: Tx, state: string): Promise<void> {
  const code = state.trim().toUpperCase();
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM state WHERE state = ${code} LIMIT 1
  `;
  if (!rows[0]) {
    throw new ValidationError(`Unknown state code "${code}". Use the 2-letter USPS code.`);
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
  orgId: string,
  careTeam: CareTeam | UpdateCareTeam | undefined,
): Promise<void> {
  const ids = [
    careTeam?.primaryNpUserId,
    careTeam?.rnUserId,
    careTeam?.socialWorkerUserId,
    careTeam?.billingAgentUserId,
  ].filter((v): v is string => typeof v === "string");
  if (ids.length === 0) return;
  // status = 'active' — invited/suspended/removed members can't be assigned;
  // a suspended NP left on a chart is a name the chart says is responsible for
  // this patient. org_id is named as well as relied on through RLS, so the
  // guard holds even if the tenant GUC is ever missed — the same shape
  // scheduleVisit (visit.service.ts) and createTimeOff (time-off.service.ts)
  // use, and it matters here because local dev connects as a superuser, for
  // which RLS is not enforced at all.
  const found = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM org_member
    WHERE org_id = ${orgId}::uuid
      AND user_id = ANY(${ids}::uuid[])
      AND status = 'active'
  `;
  const known = new Set(found.map((r) => r.user_id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new ValidationError(
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
  // The consent step's telehealth box (audit R22). It was validated and then
  // thrown away while the step said it was enforced. Stamped with the intake
  // time, it pre-ticks the consent box on this patient's telehealth visits;
  // signing still requires each visit's own acknowledgment.
  const telehealthConsentAt = payload.consents.telehealthConsent ? new Date() : null;
  // The intake emergency contact and referring physician are filed in
  // patient_contact and on the outside-provider roster (audit R30), not on the
  // patient row, whose four columns nothing read back.
  const ecName = d.emergencyContactName?.trim() || null;
  const refName = c.referringPhysicianName?.trim() || null;
  const refNpi = c.referringPhysicianNpi ?? null;
  // A phone or relationship with no name has nowhere to go: a contact needs a
  // name. Refused, rather than dropped the way the phone used to be.
  if (!ecName && (d.emergencyContactPhone || d.emergencyContactRelationship)) {
    throw new ValidationError("Add the emergency contact's name, or clear their phone and relationship.");
  }

  return withOrgContext(orgId, async (tx) => {
    await assertCareTeamMembers(tx, orgId, ct);
    // Validate the pair that will actually be stored: the policy state, or
    // the address state it falls back to in the INSERT below (audit R37).
    if (i.primaryPayerId) {
      await assertCoveragePair(tx, i.primaryPayerId, i.insuranceState ?? d.state ?? null);
    } else if (i.insuranceState) {
      await assertStateKnown(tx, i.insuranceState);
    }
    // Dual-write PHI (0034): plaintext stays source of truth for X12
    // eligibility; the _enc companion is populated when PALLIO_PHI_KEY is
    // provisioned. CASE short-circuits, so encrypt_phi never runs keyless.
    const phi = await applyPhiKeyIfConfigured(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient (
        org_id, first_name, last_name, date_of_birth,
        sex_assigned_at_birth,
        address_line_1, address_line_2, city, state, zip,
        phone,
        primary_payer_id, primary_member_id, primary_member_id_enc, primary_group_number,
        insurance_state,
        insurance_effective_date, insurance_termination_date,
        primary_diagnosis_icd10, palliative_referral_reason,
        acuity, acuity_updated_at, acuity_updated_by_user_id,
        telehealth_consent_at,
        primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
        status, created_by_user_id
      ) VALUES (
        ${orgId}::uuid, ${d.firstName}, ${d.lastName}, ${d.dateOfBirth}::date,
        ${d.sexAssignedAtBirth ?? null},
        ${d.addressLine1 ?? null}, ${d.addressLine2 ?? null}, ${d.city ?? null}, ${d.state ?? null}, ${d.zip ?? null},
        ${d.phone ?? null},
        ${i.primaryPayerId ?? null}::uuid, ${i.primaryMemberId ?? null},
        CASE WHEN ${phi} THEN encrypt_phi(${i.primaryMemberId ?? null}) ELSE NULL END,
        ${i.primaryGroupNumber ?? null},
        ${i.insuranceState ?? d.state ?? null},
        ${i.insuranceEffectiveDate ?? null}::date, ${i.insuranceTerminationDate ?? null}::date,
        ${c.primaryDiagnosisIcd10 ?? null}, ${c.palliativeReferralReason ?? null},
        ${c.acuity ?? null},
        ${c.acuity ? new Date() : null},
        ${c.acuity ? createdByUserId : null}::uuid,
        ${telehealthConsentAt}::timestamptz,
        ${ct?.primaryNpUserId ?? null}::uuid, ${ct?.rnUserId ?? null}::uuid,
        ${ct?.socialWorkerUserId ?? null}::uuid, ${ct?.billingAgentUserId ?? null}::uuid,
        'active', ${createdByUserId}::uuid
      )
      RETURNING id
    `;
    if (!rows[0]) throw new Error("createPatient: insert returned no row.");
    const patientId = rows[0].id;
    // Same transaction as the chart: a patient is never created with its
    // emergency contact or referrer half-written.
    if (ecName) {
      await insertContactRow(tx, {
        orgId,
        userId: createdByUserId,
        patientId,
        input: {
          fullName: ecName,
          relationship: d.emergencyContactRelationship ?? "other",
          phone: d.emergencyContactPhone,
          isEmergencyContact: true,
        },
      });
    }
    if (refName || refNpi) {
      // The roster row holding this NPI when there is one, so a referrer of ten
      // patients stays one row; a name alone always gets its own.
      const provider = await resolveOrCreateProvider(tx, {
        orgId,
        userId: createdByUserId,
        input: { fullName: refName ?? `NPI ${refNpi}`, npi: refNpi ?? undefined },
      });
      await insertPatientProviderLink(tx, {
        orgId,
        userId: createdByUserId,
        patientId,
        providerId: provider.id,
        role: "referring",
        roleLabel: null,
      });
    }
    // In the same transaction as the INSERT: a chart that exists without a
    // record of who created it is the gap this closes. Ids and flags only —
    // never the name, address or member id that were just written.
    await writeAudit(tx, {
      orgId,
      userId: createdByUserId,
      action: "patient_create",
      targetType: "patient",
      targetId: patientId,
      payload: {
        hasInsurance: Boolean(i.primaryPayerId),
        payerId: i.primaryPayerId ?? null,
        insuranceState: i.insuranceState ?? d.state ?? null,
        hasDiagnosis: Boolean(c.primaryDiagnosisIcd10),
        acuity: c.acuity ?? null,
        hasEmergencyContact: Boolean(ecName),
        hasReferringPhysician: Boolean(refName || refNpi),
      },
    });
    return { id: patientId };
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
  /** Only the detail read (getPatient) joins the payer name and type. */
  primary_payer_name?: string | null;
  primary_payer_type?: PatientView["primaryPayerType"];
  primary_payer_prolonged_code?: PatientView["primaryPayerProlongedCode"];
  primary_member_id: string | null;
  insurance_state: string | null;
  primary_diagnosis_icd10: string | null;
  acuity: PatientView["acuity"];
  /** DATEs, the practice's days (0107): Prisma returns them at UTC midnight. */
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
  /** Intake telehealth consent (audit R22) — only the detail read selects it. */
  telehealth_consent_at?: Date | null;
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
    primaryPayerName: row.primary_payer_name ?? null,
    primaryPayerType: row.primary_payer_type ?? null,
    primaryPayerProlongedCode: row.primary_payer_prolonged_code ?? null,
    primaryMemberId: row.primary_member_id,
    insuranceState: row.insurance_state,
    primaryDiagnosisIcd10: row.primary_diagnosis_icd10,
    acuity: row.acuity,
    lastVisitDate: row.last_visit_date ? dateColumnIso(row.last_visit_date) : null,
    nextVisitDate: row.next_visit_date ? dateColumnIso(row.next_visit_date) : null,
    careTeam: {
      primaryNp: { userId: row.primary_np_user_id, name: row.primary_np_name ?? null },
      rn: { userId: row.rn_user_id, name: row.rn_name ?? null },
      socialWorker: { userId: row.social_worker_user_id, name: row.social_worker_name ?? null },
      billingAgent: { userId: row.billing_agent_user_id, name: row.billing_agent_name ?? null },
    },
    telehealthConsentAt: row.telehealth_consent_at ? row.telehealth_consent_at.toISOString() : null,
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
             primary_payer_id, primary_member_id, insurance_state,
             pay.name AS primary_payer_name,
             -- Picks G0318 vs 99417 on the document page (audit R17). The
             -- join has no active filter on purpose: a payer withdrawn from
             -- the roster still covers the patients already on it.
             pay.payer_type AS primary_payer_type,
             -- And the payer's own choice of that code, where it names one (0108).
             pay.prolonged_service_code AS primary_payer_prolonged_code,
             primary_diagnosis_icd10, acuity,
             -- The last and next visits' days where the practice is (0107).
             -- These were instants and the screens sliced their UTC day, so an
             -- 8:30 pm Ohio visit on the 22nd read as the 23rd. Only this
             -- org's visits: the visit's patient FK is id-only.
             (SELECT (MAX(COALESCE(v.start_time, v.scheduled_start))
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             -- Seats survive offboarding (reassignment is a human decision),
             -- but the display must not pretend departed staff are current —
             -- flag any assignee whose org_member row is no longer active.
             -- Their membership of THIS org: active elsewhere is not active here.
             CASE WHEN np.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.org_id = patient.org_id
                                 AND om.user_id = np.id AND om.status = 'active')
                    THEN COALESCE(np.full_name, np.email)
                  ELSE COALESCE(np.full_name, np.email) || ' (inactive)' END AS primary_np_name,
             CASE WHEN rn.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.org_id = patient.org_id
                                 AND om.user_id = rn.id AND om.status = 'active')
                    THEN COALESCE(rn.full_name, rn.email)
                  ELSE COALESCE(rn.full_name, rn.email) || ' (inactive)' END AS rn_name,
             CASE WHEN sw.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.org_id = patient.org_id
                                 AND om.user_id = sw.id AND om.status = 'active')
                    THEN COALESCE(sw.full_name, sw.email)
                  ELSE COALESCE(sw.full_name, sw.email) || ' (inactive)' END AS social_worker_name,
             CASE WHEN ba.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.org_id = patient.org_id
                                 AND om.user_id = ba.id AND om.status = 'active')
                    THEN COALESCE(ba.full_name, ba.email)
                  ELSE COALESCE(ba.full_name, ba.email) || ' (inactive)' END AS billing_agent_name,
             patient.telehealth_consent_at,
             patient.status, patient.created_at, patient.updated_at
      FROM patient
      LEFT JOIN payer pay ON pay.id = patient.primary_payer_id
      LEFT JOIN app_user np ON np.id = patient.primary_np_user_id
      LEFT JOIN app_user rn ON rn.id = patient.rn_user_id
      LEFT JOIN app_user sw ON sw.id = patient.social_worker_user_id
      LEFT JOIN app_user ba ON ba.id = patient.billing_agent_user_id
      -- The org is named as well as enforced by RLS, so another org's patient
      -- is not found by its id on a connection that bypasses RLS.
      WHERE patient.id = ${args.id}::uuid
        AND patient.org_id = ${args.orgId}::uuid
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
    // The org is named in every statement as well as enforced by RLS, and the
    // last and next visits are this org's, as days where the practice is
    // (see getPatient).
    const rows = searchPattern
      ? await tx.$queryRaw<PatientRow[]>`
          SELECT id, first_name, last_name, date_of_birth,
                 sex_assigned_at_birth, address_line_1, city, state, zip, phone,
                 primary_payer_id, primary_member_id, insurance_state,
                 primary_diagnosis_icd10, acuity,
             (SELECT (MAX(COALESCE(v.start_time, v.scheduled_start))
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             status, created_at, updated_at
          FROM patient
          WHERE org_id = ${args.orgId}::uuid
            AND status = ${status}
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
                 primary_payer_id, primary_member_id, insurance_state,
                 primary_diagnosis_icd10, acuity,
             (SELECT (MAX(COALESCE(v.start_time, v.scheduled_start))
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             status, created_at, updated_at
          FROM patient
          WHERE org_id = ${args.orgId}::uuid
            AND status = ${status}
          ORDER BY
            CASE acuity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                       WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC,
            last_name ASC, first_name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
    const totals = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM patient
       WHERE org_id = ${args.orgId}::uuid AND status = ${status}
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
             primary_payer_id, primary_member_id, insurance_state,
             primary_diagnosis_icd10, acuity,
             (SELECT (MAX(COALESCE(v.start_time, v.scheduled_start))
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
             status, created_at, updated_at
      FROM patient
      -- Named by org as well as RLS, as in listPatients.
      WHERE org_id = ${args.orgId}::uuid
        AND (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
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

/**
 * The fields each PATCH section writes. A section counts as changed only when
 * one of these is present (audit R30): a demographics payload that carries
 * nothing the row stores writes nothing and is not audited.
 */
const DEMOGRAPHIC_KEYS: readonly (keyof NonNullable<UpdatePatient["demographics"]>)[] = [
  "firstName", "lastName", "dateOfBirth", "sexAssignedAtBirth",
  "addressLine1", "addressLine2", "city", "state", "zip", "phone",
];
const INSURANCE_KEYS: readonly (keyof NonNullable<UpdatePatient["insurance"]>)[] = [
  "primaryPayerId", "primaryMemberId", "primaryGroupNumber", "insuranceState",
  "insuranceEffectiveDate", "insuranceTerminationDate",
];
const CLINICAL_KEYS: readonly (keyof NonNullable<UpdatePatient["clinical"]>)[] = [
  "primaryDiagnosisIcd10", "palliativeReferralReason", "acuity",
];

/** Did the caller send any of these fields? (undefined = not sent.) */
function provided(section: object, keys: readonly string[]): boolean {
  return keys.some((k) => (section as Record<string, unknown>)[k] !== undefined);
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
  return withOrgContext(args.orgId, async (tx) => {
    // Existence check first — RLS filters out rows owned by another
    // org, so a missing row means "doesn't exist OR not yours". Both
    // surface as 404 (never leak cross-tenant existence). The org is named
    // here and in every statement below as well, so the same holds on a
    // connection that bypasses RLS: each UPDATE matched on the id alone.
    const exists = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid LIMIT 1
    `;
    if (exists.length === 0) throw new NotFoundError("Patient not found.");

    // Validate the pair as it will stand AFTER this update (audit R37): a new
    // payer against the stored state, or a new state against the stored
    // payer. Checking only the half being changed let a switch to an SC plan
    // keep OH.
    const ins = args.payload.insurance;
    // A demographics PATCH now writes the address state (audit R30). While no
    // policy state is stored, that is the coverage state rule lookups fall
    // back to — the fallback createPatient checks — so it is checked here too.
    const addressState = args.payload.demographics?.state;
    if (ins?.primaryPayerId || ins?.insuranceState || addressState) {
      const cur = await tx.$queryRaw<
        { primary_payer_id: string | null; insurance_state: string | null; state: string | null }[]
      >`
        SELECT primary_payer_id, insurance_state, state FROM patient
         WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
         LIMIT 1
      `;
      if (addressState) await assertStateKnown(tx, addressState);
      // Only a change to the pair re-checks it: an address change under a
      // stored policy state leaves the pair as it was.
      const pairChanges = Boolean(ins?.primaryPayerId || ins?.insuranceState || !cur[0]?.insurance_state);
      const payerId = ins?.primaryPayerId ?? cur[0]?.primary_payer_id ?? null;
      const state =
        ins?.insuranceState ?? cur[0]?.insurance_state ?? addressState ?? cur[0]?.state ?? null;
      if (payerId && pairChanges) await assertCoveragePair(tx, payerId, state);
      else if (ins?.insuranceState) await assertStateKnown(tx, ins.insuranceState);
    }

    // PHI dual-write (0034) — see createPatient.
    const phi = await applyPhiKeyIfConfigured(tx);
    // The sections that actually wrote something, for the audit row. The
    // demographics branch used to write only the name and DOB and then log
    // "demographics" for a PATCH that carried an address, a phone or a sex
    // (audit R30). Every stored field is written now, and a section sent
    // with none of its fields writes nothing and is not named.
    const sections: string[] = [];
    const d = args.payload.demographics;
    if (d && provided(d, DEMOGRAPHIC_KEYS)) {
      await tx.$executeRaw`
        UPDATE patient SET
          first_name = COALESCE(${d.firstName ?? null}, first_name),
          last_name  = COALESCE(${d.lastName ?? null},  last_name),
          date_of_birth = COALESCE(${d.dateOfBirth ?? null}::date, date_of_birth),
          sex_assigned_at_birth = COALESCE(${d.sexAssignedAtBirth ?? null}, sex_assigned_at_birth),
          address_line_1 = COALESCE(${d.addressLine1 ?? null}, address_line_1),
          address_line_2 = COALESCE(${d.addressLine2 ?? null}, address_line_2),
          city  = COALESCE(${d.city ?? null}, city),
          state = COALESCE(${d.state ?? null}, state),
          zip   = COALESCE(${d.zip ?? null}, zip),
          phone = COALESCE(${d.phone ?? null}, phone),
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("demographics");
    }
    const i = args.payload.insurance;
    if (i && provided(i, INSURANCE_KEYS)) {
      await tx.$executeRaw`
        UPDATE patient SET
          primary_payer_id   = COALESCE(${i.primaryPayerId ?? null}::uuid, primary_payer_id),
          primary_member_id  = COALESCE(${i.primaryMemberId ?? null},     primary_member_id),
          -- Mirror the plaintext: absent = keep ciphertext; provided = re-encrypt
          -- (or NULL when keyless — a stale ciphertext must never outlive its plaintext).
          primary_member_id_enc = CASE
            WHEN ${i.primaryMemberId ?? null}::text IS NULL THEN primary_member_id_enc
            WHEN ${phi} THEN encrypt_phi(${i.primaryMemberId ?? null})
            ELSE NULL
          END,
          primary_group_number = COALESCE(${i.primaryGroupNumber ?? null}, primary_group_number),
          insurance_state = COALESCE(${i.insuranceState ?? null}, insurance_state),
          insurance_effective_date  = COALESCE(${i.insuranceEffectiveDate ?? null}::date, insurance_effective_date),
          insurance_termination_date = COALESCE(${i.insuranceTerminationDate ?? null}::date, insurance_termination_date),
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("insurance");
    }
    // The referring physician is no longer written here: it lives on the
    // outside-provider roster (audit R30).
    const c = args.payload.clinical;
    if (c && provided(c, CLINICAL_KEYS)) {
      await tx.$executeRaw`
        UPDATE patient SET
          primary_diagnosis_icd10 = COALESCE(${c.primaryDiagnosisIcd10 ?? null}, primary_diagnosis_icd10),
          palliative_referral_reason = COALESCE(${c.palliativeReferralReason ?? null}, palliative_referral_reason),
          acuity = COALESCE(${c.acuity ?? null}, acuity),
          acuity_updated_at = CASE WHEN ${c.acuity ?? null}::text IS NULL THEN acuity_updated_at ELSE now() END,
          acuity_updated_by_user_id = CASE WHEN ${c.acuity ?? null}::text IS NULL THEN acuity_updated_by_user_id ELSE ${args.userId ?? null}::uuid END,
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("clinical");
    }
    if (args.payload.careTeam && Object.keys(args.payload.careTeam).length > 0) {
      const ct = args.payload.careTeam;
      await assertCareTeamMembers(tx, args.orgId, ct);
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
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("careTeam");
    }
    if (args.payload.status) {
      await tx.$executeRaw`
        UPDATE patient SET status = ${args.payload.status}, updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("status");
    }
    if (sections.length > 0) {
      // WHICH SECTIONS changed, never what they changed to. The row itself
      // holds the new values and is already access-controlled; copying them
      // here would only double the amount of PHI to protect, in a table every
      // org admin can read.
      await writeAudit(tx, {
        orgId: args.orgId,
        userId: args.userId ?? null,
        action: "patient_update",
        targetType: "patient",
        targetId: args.id,
        payload: { sections: sections.sort() },
      });
    }
    return { updated: sections.length > 0 };
  });
}
