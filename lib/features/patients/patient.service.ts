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
import { admitReferralInTx } from "@/lib/features/referrals/referral.service";
import { CARE_MANAGEMENT_VISIT_TYPE } from "@/lib/features/visits/visit.types";
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
    careTeam?.chaplainUserId,
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
  // The other two boxes on that step were required and then discarded the same
  // way, leaving no record that either was obtained (0109).
  const hipaaAcknowledgedAt = payload.consents.hipaaAcknowledged ? new Date() : null;
  const goalsOfCareConsentAt = payload.consents.goalsOfCareConsent ? new Date() : null;
  const consentSignedBy = payload.consents.signedBy?.trim() || null;
  if (i.secondaryPayerId && i.secondaryPayerId === i.primaryPayerId) {
    throw new ValidationError("The secondary insurance is the same plan as the primary. Pick a different plan, or leave secondary empty.");
  }
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
        telehealth_consent_at, hipaa_acknowledged_at, goals_of_care_consent_at, consent_signed_by,
        secondary_payer_id, secondary_member_id, secondary_member_id_enc, secondary_group_number,
        primary_np_user_id, rn_user_id, social_worker_user_id, chaplain_user_id, billing_agent_user_id,
        race_codes, ethnicity_code, preferred_language,
        status, created_by_user_id, admitted_on
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
        ${telehealthConsentAt}::timestamptz, ${hipaaAcknowledgedAt}::timestamptz,
        ${goalsOfCareConsentAt}::timestamptz, ${consentSignedBy},
        ${i.secondaryPayerId ?? null}::uuid, ${i.secondaryMemberId ?? null},
        CASE WHEN ${phi} THEN encrypt_phi(${i.secondaryMemberId ?? null}) ELSE NULL END,
        ${i.secondaryGroupNumber ?? null},
        ${ct?.primaryNpUserId ?? null}::uuid, ${ct?.rnUserId ?? null}::uuid,
        ${ct?.socialWorkerUserId ?? null}::uuid, ${ct?.chaplainUserId ?? null}::uuid, ${ct?.billingAgentUserId ?? null}::uuid,
        ${d.raceCodes ?? []}::text[], ${d.ethnicity ?? null}, ${d.preferredLanguage ?? null},
        'active', ${createdByUserId}::uuid,
        -- The day care began, where the practice is (0115, Mark Q11l).
        (now() AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = ${orgId}::uuid))::date
      )
      RETURNING id
    `;
    if (!rows[0]) throw new Error("createPatient: insert returned no row.");
    const patientId = rows[0].id;
    // The acuity given at intake starts the history (0115, Mark Q9): the
    // triage's, when this is the referral's triage acuity carried over.
    if (c.acuity) {
      const triage = payload.referralId
        ? await tx.$queryRaw<{ id: string; preliminary_acuity: string | null }[]>`
            SELECT id, preliminary_acuity FROM referral_triage
             WHERE referral_id = ${payload.referralId}::uuid AND org_id = ${orgId}::uuid
             ORDER BY triaged_at DESC LIMIT 1
          `
        : [];
      const fromTriage = triage[0]?.preliminary_acuity === c.acuity ? triage[0].id : null;
      await tx.$executeRaw`
        INSERT INTO patient_acuity_event (org_id, patient_id, acuity, source, referral_triage_id, recorded_by_user_id)
        VALUES (${orgId}::uuid, ${patientId}::uuid, ${c.acuity}, ${fromTriage ? "triage" : "intake"},
                ${fromTriage}::uuid, ${createdByUserId}::uuid)
      `;
    }
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
    // Admitting a referral (0111): the referral names this patient from now
    // on, or the whole intake rolls back.
    if (payload.referralId) {
      await admitReferralInTx(tx, {
        orgId,
        referralId: payload.referralId,
        patientId,
        userId: createdByUserId,
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
        referralId: payload.referralId ?? null,
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
  chaplain_user_id?: string | null;
  billing_agent_user_id: string | null;
  /** Assignee display names — only the detail read (getPatient) resolves these. */
  primary_np_name?: string | null;
  rn_name?: string | null;
  social_worker_name?: string | null;
  chaplain_name?: string | null;
  billing_agent_name?: string | null;
  /** USCDI (0128) — only the detail read selects these. */
  race_codes?: string[] | null;
  ethnicity_code?: string | null;
  preferred_language?: string | null;
  /** Intake telehealth consent (audit R22) — only the detail read selects it. */
  telehealth_consent_at?: Date | null;
  /** Detail read only (0109 and the chart's edit forms). */
  address_line_2?: string | null;
  primary_group_number?: string | null;
  insurance_effective_date?: Date | null;
  insurance_termination_date?: Date | null;
  palliative_referral_reason?: string | null;
  secondary_payer_id?: string | null;
  secondary_payer_name?: string | null;
  secondary_member_id?: string | null;
  secondary_group_number?: string | null;
  hipaa_acknowledged_at?: Date | null;
  goals_of_care_consent_at?: Date | null;
  consent_signed_by?: string | null;
  referral_id?: string | null;
  referral_received_on?: string | null;
  referral_source_name?: string | null;
  status: PatientStatus;
  created_at: Date;
  updated_at: Date;
}

/** A DATE column as 'YYYY-MM-DD' (Prisma hands DATEs back at UTC midnight). */
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

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
      chaplain: { userId: row.chaplain_user_id ?? null, name: row.chaplain_name ?? null },
      billingAgent: { userId: row.billing_agent_user_id, name: row.billing_agent_name ?? null },
    },
    telehealthConsentAt: row.telehealth_consent_at ? row.telehealth_consent_at.toISOString() : null,
    raceCodes: row.race_codes ?? [],
    ethnicity: row.ethnicity_code ?? null,
    preferredLanguage: row.preferred_language ?? null,
    // Only a detail read selects these; a list read leaves them undefined.
    ...(row.palliative_referral_reason !== undefined && {
      addressLine2: row.address_line_2 ?? null,
      primaryGroupNumber: row.primary_group_number ?? null,
      insuranceEffectiveDate: dateOnly(row.insurance_effective_date),
      insuranceTerminationDate: dateOnly(row.insurance_termination_date),
      // '' is how the detail read marks "no reason" (it never selects NULL here).
      palliativeReferralReason: row.palliative_referral_reason || null,
      secondaryPayerId: row.secondary_payer_id ?? null,
      secondaryPayerName: row.secondary_payer_name ?? null,
      secondaryMemberId: row.secondary_member_id ?? null,
      secondaryGroupNumber: row.secondary_group_number ?? null,
      hipaaAcknowledgedAt: row.hipaa_acknowledged_at ? row.hipaa_acknowledged_at.toISOString() : null,
      goalsOfCareConsentAt: row.goals_of_care_consent_at ? row.goals_of_care_consent_at.toISOString() : null,
      consentSignedBy: row.consent_signed_by ?? null,
      referral: row.referral_id
        ? {
            id: row.referral_id,
            receivedOn: row.referral_received_on ?? "",
            sourceName: row.referral_source_name ?? null,
          }
        : null,
    }),
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
             -- org's visits: the visit's patient FK is id-only. The last is one
             -- that took place; the next one still to come, booked or started
             -- ahead of its time. A cancelled or no-show visit is neither, and
             -- a PCM/CCM month's charge (0117) is no visit at all. The caseload
             -- reads them the same way.
             (SELECT (MAX(COALESCE(v.start_time, v.scheduled_start))
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
                 AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.status IN ('scheduled', 'in_progress')
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, chaplain_user_id, billing_agent_user_id,
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
             CASE WHEN ch.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.org_id = patient.org_id
                                 AND om.user_id = ch.id AND om.status = 'active')
                    THEN COALESCE(ch.full_name, ch.email)
                  ELSE COALESCE(ch.full_name, ch.email) || ' (inactive)' END AS chaplain_name,
             CASE WHEN ba.id IS NULL THEN NULL
                  WHEN EXISTS (SELECT 1 FROM org_member om WHERE om.org_id = patient.org_id
                                 AND om.user_id = ba.id AND om.status = 'active')
                    THEN COALESCE(ba.full_name, ba.email)
                  ELSE COALESCE(ba.full_name, ba.email) || ' (inactive)' END AS billing_agent_name,
             patient.telehealth_consent_at,
             patient.race_codes, patient.ethnicity_code, patient.preferred_language,
             -- What the chart's edit forms start from, and the referral reason
             -- intake stored and nothing showed again (audit 27 Oct, doc:22).
             patient.address_line_2, patient.primary_group_number,
             patient.insurance_effective_date, patient.insurance_termination_date,
             COALESCE(patient.palliative_referral_reason, '') AS palliative_referral_reason,
             patient.secondary_payer_id, sec.name AS secondary_payer_name,
             patient.secondary_member_id, patient.secondary_group_number,
             patient.hipaa_acknowledged_at, patient.goals_of_care_consent_at, patient.consent_signed_by,
             ref.referral_id, ref.referral_received_on, ref.referral_source_name,
             patient.status, patient.created_at, patient.updated_at
      FROM patient
      LEFT JOIN payer pay ON pay.id = patient.primary_payer_id
      LEFT JOIN payer sec ON sec.id = patient.secondary_payer_id
      -- The referral this patient was admitted from (0111), if any. A lateral
      -- subquery naming only these three: referral has its own first_name,
      -- phone and the rest, which the unqualified columns above would collide
      -- with.
      LEFT JOIN LATERAL (
        SELECT r.id AS referral_id,
               to_char(r.received_on, 'YYYY-MM-DD') AS referral_received_on,
               r.source_name AS referral_source_name
          FROM referral r
         WHERE r.patient_id = patient.id AND r.org_id = patient.org_id
         LIMIT 1
      ) ref ON true
      LEFT JOIN app_user np ON np.id = patient.primary_np_user_id
      LEFT JOIN app_user rn ON rn.id = patient.rn_user_id
      LEFT JOIN app_user sw ON sw.id = patient.social_worker_user_id
      LEFT JOIN app_user ch ON ch.id = patient.chaplain_user_id
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
                 AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
                 AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.status IN ('scheduled', 'in_progress')
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, chaplain_user_id, billing_agent_user_id,
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
                 AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
                 AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.status IN ('scheduled', 'in_progress')
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, chaplain_user_id, billing_agent_user_id,
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
                 AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
                 AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()) AS last_visit_date,
             (SELECT (MIN(v.scheduled_start)
                        AT TIME ZONE (SELECT o.timezone FROM org o WHERE o.id = patient.org_id))::date
                FROM visit v
               WHERE v.patient_id = patient.id AND v.org_id = patient.org_id
                 AND v.status IN ('scheduled', 'in_progress')
                 AND v.scheduled_start > now()) AS next_visit_date,
             primary_np_user_id, rn_user_id, social_worker_user_id, chaplain_user_id, billing_agent_user_id,
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
  "raceCodes", "ethnicity", "preferredLanguage",
];
const INSURANCE_KEYS: readonly (keyof NonNullable<UpdatePatient["insurance"]>)[] = [
  "primaryPayerId", "primaryMemberId", "primaryGroupNumber", "insuranceState",
  "insuranceEffectiveDate", "insuranceTerminationDate",
  "secondaryPayerId", "secondaryMemberId", "secondaryGroupNumber",
];
const CLINICAL_KEYS: readonly (keyof NonNullable<UpdatePatient["clinical"]>)[] = [
  "primaryDiagnosisIcd10", "palliativeReferralReason", "acuity",
];
const CONSENT_KEYS: readonly (keyof NonNullable<UpdatePatient["consents"]>)[] = [
  "hipaaAcknowledged", "goalsOfCareConsent", "telehealthConsent", "signedBy",
];

/** Did the caller send any of these fields? (undefined = not sent.) */
function provided(section: object, keys: readonly string[]): boolean {
  return keys.some((k) => (section as Record<string, unknown>)[k] !== undefined);
}

/** Tri-state flag for a nullable column: was the field sent at all (null clears). */
const sent = (v: unknown) => v !== undefined;

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
      // Tri-state (UpdatePatientSchema): a field not sent keeps its value, null
      // clears it. COALESCE alone could replace a wrong phone but never remove it.
      await tx.$executeRaw`
        UPDATE patient SET
          first_name = COALESCE(${d.firstName ?? null}, first_name),
          last_name  = COALESCE(${d.lastName ?? null},  last_name),
          date_of_birth = COALESCE(${d.dateOfBirth ?? null}::date, date_of_birth),
          sex_assigned_at_birth = CASE WHEN ${sent(d.sexAssignedAtBirth)} THEN ${d.sexAssignedAtBirth ?? null} ELSE sex_assigned_at_birth END,
          address_line_1 = CASE WHEN ${sent(d.addressLine1)} THEN ${d.addressLine1 ?? null} ELSE address_line_1 END,
          address_line_2 = CASE WHEN ${sent(d.addressLine2)} THEN ${d.addressLine2 ?? null} ELSE address_line_2 END,
          city  = CASE WHEN ${sent(d.city)} THEN ${d.city ?? null} ELSE city END,
          state = CASE WHEN ${sent(d.state)} THEN ${d.state ?? null} ELSE state END,
          zip   = CASE WHEN ${sent(d.zip)} THEN ${d.zip ?? null} ELSE zip END,
          phone = CASE WHEN ${sent(d.phone)} THEN ${d.phone ?? null} ELSE phone END,
          race_codes = CASE WHEN ${sent(d.raceCodes)} THEN ${d.raceCodes ?? []}::text[] ELSE race_codes END,
          ethnicity_code = CASE WHEN ${sent(d.ethnicity)} THEN ${d.ethnicity ?? null} ELSE ethnicity_code END,
          preferred_language = CASE WHEN ${sent(d.preferredLanguage)} THEN ${d.preferredLanguage ?? null} ELSE preferred_language END,
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("demographics");
    }
    const i = args.payload.insurance;
    if (i && provided(i, INSURANCE_KEYS)) {
      if (i.secondaryPayerId) {
        const both = await tx.$queryRaw<{ primary_payer_id: string | null }[]>`
          SELECT primary_payer_id FROM patient WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
        `;
        if ((i.primaryPayerId ?? both[0]?.primary_payer_id) === i.secondaryPayerId) {
          throw new ValidationError("The secondary insurance is the same plan as the primary. Pick a different plan, or clear secondary.");
        }
      }
      await tx.$executeRaw`
        UPDATE patient SET
          primary_payer_id   = COALESCE(${i.primaryPayerId ?? null}::uuid, primary_payer_id),
          primary_member_id  = CASE WHEN ${sent(i.primaryMemberId)} THEN ${i.primaryMemberId ?? null} ELSE primary_member_id END,
          -- Mirror the plaintext: not sent = keep ciphertext; sent = re-encrypt,
          -- or NULL when cleared or keyless — a stale ciphertext must never
          -- outlive its plaintext.
          primary_member_id_enc = CASE
            WHEN NOT ${sent(i.primaryMemberId)} THEN primary_member_id_enc
            WHEN ${i.primaryMemberId ?? null}::text IS NOT NULL AND ${phi} THEN encrypt_phi(${i.primaryMemberId ?? null})
            ELSE NULL
          END,
          primary_group_number = CASE WHEN ${sent(i.primaryGroupNumber)} THEN ${i.primaryGroupNumber ?? null} ELSE primary_group_number END,
          insurance_state = COALESCE(${i.insuranceState ?? null}, insurance_state),
          insurance_effective_date  = CASE WHEN ${sent(i.insuranceEffectiveDate)} THEN ${i.insuranceEffectiveDate ?? null}::date ELSE insurance_effective_date END,
          insurance_termination_date = CASE WHEN ${sent(i.insuranceTerminationDate)} THEN ${i.insuranceTerminationDate ?? null}::date ELSE insurance_termination_date END,
          secondary_payer_id = CASE WHEN ${sent(i.secondaryPayerId)} THEN ${i.secondaryPayerId ?? null}::uuid ELSE secondary_payer_id END,
          secondary_member_id = CASE WHEN ${sent(i.secondaryMemberId)} THEN ${i.secondaryMemberId ?? null} ELSE secondary_member_id END,
          secondary_member_id_enc = CASE
            WHEN NOT ${sent(i.secondaryMemberId)} THEN secondary_member_id_enc
            WHEN ${i.secondaryMemberId ?? null}::text IS NOT NULL AND ${phi} THEN encrypt_phi(${i.secondaryMemberId ?? null})
            ELSE NULL
          END,
          secondary_group_number = CASE WHEN ${sent(i.secondaryGroupNumber)} THEN ${i.secondaryGroupNumber ?? null} ELSE secondary_group_number END,
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("insurance");
    }
    // The referring physician is no longer written here: it lives on the
    // outside-provider roster (audit R30).
    const c = args.payload.clinical;
    if (c && provided(c, CLINICAL_KEYS)) {
      // A changed acuity joins the history as a review on the chart (0115,
      // Mark Q9), before the row takes the new value. The same value again is
      // not a new judgement.
      if (c.acuity) {
        await tx.$executeRaw`
          INSERT INTO patient_acuity_event (org_id, patient_id, acuity, source, recorded_by_user_id)
          SELECT org_id, id, ${c.acuity}, 'review', ${args.userId ?? null}::uuid FROM patient
           WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
             AND acuity IS DISTINCT FROM ${c.acuity}
        `;
      }
      await tx.$executeRaw`
        UPDATE patient SET
          primary_diagnosis_icd10 = CASE WHEN ${sent(c.primaryDiagnosisIcd10)} THEN ${c.primaryDiagnosisIcd10 ?? null} ELSE primary_diagnosis_icd10 END,
          palliative_referral_reason = CASE WHEN ${sent(c.palliativeReferralReason)} THEN ${c.palliativeReferralReason ?? null} ELSE palliative_referral_reason END,
          acuity = COALESCE(${c.acuity ?? null}, acuity),
          acuity_updated_at = CASE WHEN ${c.acuity ?? null}::text IS NULL THEN acuity_updated_at ELSE now() END,
          acuity_updated_by_user_id = CASE WHEN ${c.acuity ?? null}::text IS NULL THEN acuity_updated_by_user_id ELSE ${args.userId ?? null}::uuid END,
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("clinical");
    }
    // Consents recorded or withdrawn after intake (0109): true keeps the date
    // already on file or stamps now; false clears it.
    const k = args.payload.consents;
    if (k && provided(k, CONSENT_KEYS)) {
      await tx.$executeRaw`
        UPDATE patient SET
          hipaa_acknowledged_at = CASE
            WHEN NOT ${sent(k.hipaaAcknowledged)} THEN hipaa_acknowledged_at
            WHEN ${k.hipaaAcknowledged === true} THEN COALESCE(hipaa_acknowledged_at, now())
            ELSE NULL END,
          goals_of_care_consent_at = CASE
            WHEN NOT ${sent(k.goalsOfCareConsent)} THEN goals_of_care_consent_at
            WHEN ${k.goalsOfCareConsent === true} THEN COALESCE(goals_of_care_consent_at, now())
            ELSE NULL END,
          telehealth_consent_at = CASE
            WHEN NOT ${sent(k.telehealthConsent)} THEN telehealth_consent_at
            WHEN ${k.telehealthConsent === true} THEN COALESCE(telehealth_consent_at, now())
            ELSE NULL END,
          consent_signed_by = CASE WHEN ${sent(k.signedBy)} THEN ${k.signedBy || null} ELSE consent_signed_by END,
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("consents");
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
          chaplain_user_id      = CASE WHEN ${ct.chaplainUserId === undefined} THEN chaplain_user_id      ELSE ${ct.chaplainUserId ?? null}::uuid END,
          billing_agent_user_id = CASE WHEN ${ct.billingAgentUserId === undefined} THEN billing_agent_user_id ELSE ${ct.billingAgentUserId ?? null}::uuid END,
          updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      sections.push("careTeam");
    }
    if (args.payload.status) {
      // Archiving, and back, is all a status change here does. A discharge or
      // a death carries its day and the practice's reason (0115): set as a
      // bare status it said neither, and discharged_at was never written. A
      // discharged patient comes back by readmission, which starts an episode.
      let to = args.payload.status;
      if (to === "discharged" || to === "deceased") {
        throw new ValidationError("Discharge the patient from the chart, with the day and the reason.");
      }
      const cur = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM patient WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      if (to === "active" && cur[0] && cur[0].status !== "archived" && cur[0].status !== "active") {
        throw new ValidationError("Readmit the patient from the chart to bring them back under care.");
      }
      // Unarchiving brings the chart back as it was: archived after a
      // discharge, the patient is still discharged until readmitted.
      if (to === "active" && cur[0]?.status === "archived") {
        const d = await tx.$queryRaw<{ died: boolean }[]>`
          SELECT died_on IS NOT NULL AS died FROM patient_discharge
           WHERE patient_id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid AND reversed_at IS NULL
        `;
        if (d[0]) to = d[0].died ? "deceased" : "discharged";
      }
      await tx.$executeRaw`
        UPDATE patient SET status = ${to}, updated_at = now()
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
