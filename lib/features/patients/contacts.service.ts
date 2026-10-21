/**
 * Family and caregivers on a patient (audit R30).
 *
 * The chart held one unlabelled emergency-contact pair, which could not hold a
 * daughter-in-law who is the caregiver and a nephew who holds power of
 * attorney, and nothing read back what it did hold. These rows are what the
 * chart's "Family & caregivers" card edits, what the note header's POA and
 * caregiver lines print, and part of the right-of-access export.
 *
 * Every function runs inside withOrgContext and starts by looking the patient
 * up. RLS hides another org's patient, so a miss is a 404 whether the patient
 * does not exist or is not yours. Audit rows carry the contact's id and the
 * NAMES of the columns written — never a name, phone number or note.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import type {
  ContactRelationship,
  PatientContact,
  PatientContactInput,
  PatientContactView,
  UpdatePatientContact,
} from "./contacts.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** Input keys and the columns they write, for the audit payload. */
const CONTACT_COLUMNS: Record<keyof PatientContact, string> = {
  fullName: "full_name",
  relationship: "relationship",
  phone: "phone",
  altPhone: "alt_phone",
  email: "email",
  isPrimaryCaregiver: "is_primary_caregiver",
  isEmergencyContact: "is_emergency_contact",
  isHealthcarePoa: "is_healthcare_poa",
  livesWithPatient: "lives_with_patient",
  notes: "notes",
};

/**
 * The columns an input writes. On create a role left unticked writes nothing
 * worth naming; on update `false` is a role being cleared, so it counts.
 */
function writtenColumns(input: Record<string, unknown>, op: "create" | "update"): string[] {
  return Object.entries(input)
    .filter(([k, v]) => k in CONTACT_COLUMNS && v !== undefined && !(op === "create" && v === false))
    .map(([k]) => CONTACT_COLUMNS[k as keyof PatientContact])
    .sort();
}

/**
 * Did this statement lose a race against a unique index? Detected by the
 * SQLSTATE, never the constraint name, because Prisma does not report the
 * name: a 23505 from $queryRaw arrives as P2010 with meta.code '23505' and a
 * message of "Unique constraint failed: ". Matching the name in the text was
 * always false, so every unique-index backstop here and in
 * external-providers.service answered a lost race with a 500 instead of the
 * pre-check's 422 (audit R30). A bare '23505' is node-pg's shape. The caller
 * knows which unique index its table has, and names the rule itself.
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  return (e?.code === "P2010" && e?.meta?.code === "23505") || e?.code === "23505";
}

/**
 * 404 unless the patient is this org's. Named by org as well as left to RLS:
 * on a connection that bypasses RLS the id alone found another org's patient,
 * and every contact and provider read or write behind this check followed it.
 */
export async function assertPatientInOrg(tx: Tx, orgId: string, patientId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM patient WHERE id = ${patientId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
  `;
  if (rows.length === 0) throw new NotFoundError("Patient not found.");
}

/**
 * One healthcare POA per patient. Checked before any write so the message can
 * name who holds it; the partial unique index patient_contact_one_poa is the
 * backstop for two saves at once.
 */
async function assertNoOtherPoa(
  tx: Tx,
  orgId: string,
  patientId: string,
  exceptContactId: string | null,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string; full_name: string }[]>`
    SELECT id, full_name FROM patient_contact
     WHERE patient_id = ${patientId}::uuid
       AND is_healthcare_poa
       AND id IS DISTINCT FROM ${exceptContactId}::uuid
       AND org_id = ${orgId}::uuid
     LIMIT 1
  `;
  if (rows[0]) {
    throw new ValidationError(
      `${rows[0].full_name} is already this patient's healthcare POA. Clear it on their entry first.`,
    );
  }
}

// Also what a lost race on patient_contact means: its only unique index
// besides the key is patient_contact_one_poa, so any 23505 there is the POA.
const POA_TAKEN = "This patient already has a healthcare POA on file. Clear it on that contact first.";

interface ContactRow {
  id: string;
  full_name: string;
  relationship: ContactRelationship;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  is_primary_caregiver: boolean;
  is_emergency_contact: boolean;
  is_healthcare_poa: boolean;
  lives_with_patient: boolean;
  notes: string | null;
  updated_at: Date;
}

function rowToContact(r: ContactRow): PatientContactView {
  return {
    id: r.id,
    fullName: r.full_name,
    relationship: r.relationship,
    phone: r.phone,
    altPhone: r.alt_phone,
    email: r.email,
    isPrimaryCaregiver: r.is_primary_caregiver,
    isEmergencyContact: r.is_emergency_contact,
    isHealthcarePoa: r.is_healthcare_poa,
    livesWithPatient: r.lives_with_patient,
    notes: r.notes,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * The INSERT itself, inside the caller's transaction. Shared with
 * createPatient, which records the intake emergency contact here and audits
 * it as part of patient_create. The caller has already checked the patient
 * and the POA rule.
 */
export async function insertContactRow(
  tx: Tx,
  args: { orgId: string; userId: string; patientId: string; input: PatientContactInput },
): Promise<PatientContactView> {
  const { orgId, userId, patientId, input: i } = args;
  let rows: ContactRow[];
  try {
    rows = await tx.$queryRaw<ContactRow[]>`
      INSERT INTO patient_contact (
        org_id, patient_id, full_name, relationship, phone, alt_phone, email,
        is_primary_caregiver, is_emergency_contact, is_healthcare_poa, lives_with_patient,
        notes, created_by_user_id, updated_by_user_id
      ) VALUES (
        ${orgId}::uuid, ${patientId}::uuid, ${i.fullName}, ${i.relationship},
        ${i.phone ?? null}, ${i.altPhone ?? null}, ${i.email ?? null},
        ${i.isPrimaryCaregiver ?? false}, ${i.isEmergencyContact ?? false},
        ${i.isHealthcarePoa ?? false}, ${i.livesWithPatient ?? false},
        ${i.notes ?? null}, ${userId}::uuid, ${userId}::uuid
      )
      RETURNING id, full_name, relationship, phone, alt_phone, email,
                is_primary_caregiver, is_emergency_contact, is_healthcare_poa,
                lives_with_patient, notes, updated_at
    `;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(POA_TAKEN);
    throw err;
  }
  if (!rows[0]) throw new Error("insertContactRow: insert returned no row.");
  return rowToContact(rows[0]);
}

export async function listContacts(args: {
  orgId: string;
  patientId: string;
}): Promise<PatientContactView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    await assertPatientInOrg(tx, args.orgId, args.patientId);
    const rows = await tx.$queryRaw<ContactRow[]>`
      SELECT id, full_name, relationship, phone, alt_phone, email,
             is_primary_caregiver, is_emergency_contact, is_healthcare_poa,
             lives_with_patient, notes, updated_at
        FROM patient_contact
       WHERE patient_id = ${args.patientId}::uuid
         AND org_id = ${args.orgId}::uuid
       ORDER BY is_healthcare_poa DESC, is_primary_caregiver DESC,
                is_emergency_contact DESC, lower(full_name), id
    `;
    return rows.map(rowToContact);
  });
}

export async function createContact(args: {
  orgId: string;
  userId: string;
  patientId: string;
  input: PatientContactInput;
}): Promise<PatientContactView> {
  return withOrgContext(args.orgId, async (tx) => {
    await assertPatientInOrg(tx, args.orgId, args.patientId);
    if (args.input.isHealthcarePoa) await assertNoOtherPoa(tx, args.orgId, args.patientId, null);
    const contact = await insertContactRow(tx, args);
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "patient_contact_change",
      targetType: "patient",
      targetId: args.patientId,
      payload: { contactId: contact.id, op: "create", fields: writtenColumns(args.input, "create") },
    });
    return contact;
  });
}

export async function updateContact(args: {
  orgId: string;
  userId: string;
  patientId: string;
  contactId: string;
  patch: UpdatePatientContact;
}): Promise<PatientContactView> {
  const p = args.patch;
  // Tri-state per text field: absent = keep, null = clear, value = set.
  // COALESCE can't express "explicit null clears", so each CASE is driven by
  // a "was it provided" boolean (the care-team pattern in patient.service).
  const keep = (v: unknown) => v === undefined;
  return withOrgContext(args.orgId, async (tx) => {
    await assertPatientInOrg(tx, args.orgId, args.patientId);
    if (p.isHealthcarePoa === true) await assertNoOtherPoa(tx, args.orgId, args.patientId, args.contactId);
    let rows: ContactRow[];
    try {
      rows = await tx.$queryRaw<ContactRow[]>`
        UPDATE patient_contact SET
          full_name    = CASE WHEN ${keep(p.fullName)} THEN full_name ELSE ${p.fullName ?? null} END,
          relationship = CASE WHEN ${keep(p.relationship)} THEN relationship ELSE ${p.relationship ?? null} END,
          phone        = CASE WHEN ${keep(p.phone)} THEN phone ELSE ${p.phone ?? null} END,
          alt_phone    = CASE WHEN ${keep(p.altPhone)} THEN alt_phone ELSE ${p.altPhone ?? null} END,
          email        = CASE WHEN ${keep(p.email)} THEN email ELSE ${p.email ?? null} END,
          notes        = CASE WHEN ${keep(p.notes)} THEN notes ELSE ${p.notes ?? null} END,
          is_primary_caregiver = COALESCE(${p.isPrimaryCaregiver ?? null}::boolean, is_primary_caregiver),
          is_emergency_contact = COALESCE(${p.isEmergencyContact ?? null}::boolean, is_emergency_contact),
          is_healthcare_poa    = COALESCE(${p.isHealthcarePoa ?? null}::boolean, is_healthcare_poa),
          lives_with_patient   = COALESCE(${p.livesWithPatient ?? null}::boolean, lives_with_patient),
          updated_at = now(),
          updated_by_user_id = ${args.userId}::uuid
        WHERE id = ${args.contactId}::uuid AND patient_id = ${args.patientId}::uuid
          AND org_id = ${args.orgId}::uuid
        RETURNING id, full_name, relationship, phone, alt_phone, email,
                  is_primary_caregiver, is_emergency_contact, is_healthcare_poa,
                  lives_with_patient, notes, updated_at
      `;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ValidationError(POA_TAKEN);
      throw err;
    }
    // Scoped to the patient in the URL as well as the id, so a contact id
    // from another chart is "not found" rather than edited.
    if (!rows[0]) throw new NotFoundError("Contact not found.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "patient_contact_change",
      targetType: "patient",
      targetId: args.patientId,
      payload: { contactId: args.contactId, op: "update", fields: writtenColumns(p, "update") },
    });
    return rowToContact(rows[0]);
  });
}

export async function deleteContact(args: {
  orgId: string;
  userId: string;
  patientId: string;
  contactId: string;
}): Promise<{ deleted: true }> {
  return withOrgContext(args.orgId, async (tx) => {
    await assertPatientInOrg(tx, args.orgId, args.patientId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      DELETE FROM patient_contact
       WHERE id = ${args.contactId}::uuid AND patient_id = ${args.patientId}::uuid
         AND org_id = ${args.orgId}::uuid
      RETURNING id
    `;
    if (!rows[0]) throw new NotFoundError("Contact not found.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "patient_contact_change",
      targetType: "patient",
      targetId: args.patientId,
      payload: { contactId: args.contactId, op: "delete" },
    });
    return { deleted: true };
  });
}
