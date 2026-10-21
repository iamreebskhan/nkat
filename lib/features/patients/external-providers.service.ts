/**
 * Outside providers (audit R30): the org's roster of clinicians outside the
 * practice, and who each one is to a patient.
 *
 * One referring-physician pair per patient could not hold the PCP, the
 * pulmonologist and the oncologist in the header of Mark's note, and nothing
 * read it back. The roster is per org and keyed by NPI where one is known, so
 * a PCP who refers ten patients is one row: correct her fax once and every
 * chart has it. A name alone is not an identity, so name-only entries are
 * never merged.
 *
 * Audit rows: 'patient_provider_change' when a patient's links change, and
 * 'external_provider_change' when the roster itself does. Ids, roles and
 * column names only. A provider's details are not PHI on their own, but next
 * to a patient id they say who treats whom.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { assertPatientInOrg, isUniqueViolation } from "./contacts.service";
import type {
  ExternalProviderInput,
  ExternalProviderRole,
  ExternalProviderView,
  LinkExternalProvider,
  PatientProviderView,
  UpdateExternalProvider,
} from "./contacts.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

const PROVIDER_COLUMNS: Record<keyof ExternalProviderInput, string> = {
  fullName: "full_name",
  npi: "npi",
  specialty: "specialty",
  practiceName: "practice_name",
  phone: "phone",
  fax: "fax",
};

const providerColumns = (input: Record<string, unknown>): string[] =>
  Object.entries(input)
    .filter(([k, v]) => k in PROVIDER_COLUMNS && v !== undefined)
    .map(([k]) => PROVIDER_COLUMNS[k as keyof ExternalProviderInput])
    .sort();

interface ProviderRow {
  id: string;
  full_name: string;
  npi: string | null;
  specialty: string | null;
  practice_name: string | null;
  phone: string | null;
  fax: string | null;
}

function rowToProvider(r: ProviderRow): ExternalProviderView {
  return {
    id: r.id,
    fullName: r.full_name,
    npi: r.npi,
    specialty: r.specialty,
    practiceName: r.practice_name,
    phone: r.phone,
    fax: r.fax,
  };
}

/**
 * The roster row for this provider: the one already holding the NPI, or a new
 * one. Runs in the caller's transaction (linkPatientProvider, and
 * createPatient for the intake referring physician). A new row writes its own
 * 'external_provider_change' audit, so the roster's history starts where the
 * row does.
 */
export async function resolveOrCreateProvider(
  tx: Tx,
  args: { orgId: string; userId: string; input: ExternalProviderInput },
): Promise<{ id: string; created: boolean }> {
  const i = args.input;
  // The roster is per org, and so is an NPI's row on it (external_provider's
  // unique key is org and NPI). Named by org as well as left to RLS: on a
  // connection that bypasses RLS the NPI alone found another practice's row for
  // the same doctor, and the patient was linked to it.
  if (i.npi) {
    const found = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM external_provider WHERE npi = ${i.npi} AND org_id = ${args.orgId}::uuid LIMIT 1
    `;
    if (found[0]) return { id: found[0].id, created: false };
  }
  // ON CONFLICT: two saves racing on the same new NPI end up on one row.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO external_provider (
      org_id, full_name, npi, specialty, practice_name, phone, fax, created_by_user_id
    ) VALUES (
      ${args.orgId}::uuid, ${i.fullName}, ${i.npi ?? null}, ${i.specialty ?? null},
      ${i.practiceName ?? null}, ${i.phone ?? null}, ${i.fax ?? null}, ${args.userId}::uuid
    )
    ON CONFLICT (org_id, npi) WHERE npi IS NOT NULL DO NOTHING
    RETURNING id
  `;
  if (!rows[0]) {
    const again = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM external_provider WHERE npi = ${i.npi ?? null} AND org_id = ${args.orgId}::uuid LIMIT 1
    `;
    if (!again[0]) throw new Error("resolveOrCreateProvider: insert returned no row.");
    return { id: again[0].id, created: false };
  }
  await writeAudit(tx, {
    orgId: args.orgId,
    userId: args.userId,
    action: "external_provider_change",
    targetType: "external_provider",
    targetId: rows[0].id,
    payload: { op: "create", fields: providerColumns(i) },
  });
  return { id: rows[0].id, created: true };
}

const ROLE_TAKEN: Partial<Record<ExternalProviderRole, string>> = {
  primary_care: "This patient already has a primary care provider. Remove that one first to replace them.",
  referring: "This patient already has a referring physician. Remove that one first to replace them.",
};

/**
 * The link INSERT, in the caller's transaction, after the caller has checked
 * the patient. Shared with createPatient. Pre-checks the one-PCP and
 * one-referrer rules and a duplicate link, so the 422 is readable; the unique
 * indexes are the backstop for a race.
 */
export async function insertPatientProviderLink(
  tx: Tx,
  args: {
    orgId: string;
    userId: string;
    patientId: string;
    providerId: string;
    role: ExternalProviderRole;
    roleLabel: string | null;
  },
): Promise<{ linkId: string }> {
  const taken = ROLE_TAKEN[args.role];
  if (taken) {
    const held = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient_external_provider
       WHERE patient_id = ${args.patientId}::uuid AND role = ${args.role}
         AND org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    if (held[0]) throw new ValidationError(taken);
  }
  const dup = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM patient_external_provider
     WHERE patient_id = ${args.patientId}::uuid
       AND external_provider_id = ${args.providerId}::uuid
       AND role = ${args.role}
       AND org_id = ${args.orgId}::uuid
     LIMIT 1
  `;
  if (dup[0]) throw new ValidationError("That provider is already linked to this patient in that role.");

  // A label only means something where the role does not fix it.
  const roleLabel = args.role === "specialist" || args.role === "other" ? args.roleLabel : null;
  let rows: { id: string }[];
  try {
    rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_external_provider (
        org_id, patient_id, external_provider_id, role, role_label, created_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${args.patientId}::uuid, ${args.providerId}::uuid,
        ${args.role}, ${roleLabel}, ${args.userId}::uuid
      )
      RETURNING id
    `;
  } catch (err) {
    // A save that raced the pre-checks above. Prisma does not say which of
    // pep_one_pcp, pep_one_referring or pep_patient_provider_role_uniq fired,
    // but the role does: for a PCP or a referrer even a duplicate link means
    // the role is held, and for any other role only the duplicate-link index
    // applies (audit R30).
    if (isUniqueViolation(err)) {
      throw new ValidationError(taken ?? "That provider is already linked to this patient in that role.");
    }
    throw err;
  }
  if (!rows[0]) throw new Error("insertPatientProviderLink: insert returned no row.");
  return { linkId: rows[0].id };
}

/** Roster typeahead: active providers by name, practice, or an exact NPI. */
export async function listOrgProviders(args: {
  orgId: string;
  q?: string | null;
}): Promise<ExternalProviderView[]> {
  const q = args.q?.trim() || null;
  // Escape LIKE's own wildcards so "50%" searches for the text "50%".
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<ProviderRow[]>`
      SELECT id, full_name, npi, specialty, practice_name, phone, fax
        FROM external_provider
       WHERE active
         AND org_id = ${args.orgId}::uuid
         AND (${like}::text IS NULL
              OR full_name ILIKE ${like}
              OR practice_name ILIKE ${like}
              OR npi = ${q})
       ORDER BY lower(full_name), id
       LIMIT 20
    `;
    return rows.map(rowToProvider);
  });
}

/** Fix a roster entry once, for every patient that links it. */
export async function updateOrgProvider(args: {
  orgId: string;
  userId: string;
  providerId: string;
  patch: UpdateExternalProvider;
}): Promise<ExternalProviderView> {
  const p = args.patch;
  const keep = (v: unknown) => v === undefined;
  return withOrgContext(args.orgId, async (tx) => {
    if (p.npi) {
      const clash = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM external_provider
         WHERE npi = ${p.npi} AND id <> ${args.providerId}::uuid
           AND org_id = ${args.orgId}::uuid
         LIMIT 1
      `;
      if (clash[0]) {
        throw new ValidationError("Another provider on your roster already has that NPI. Link that entry instead.");
      }
    }
    let rows: ProviderRow[];
    try {
      rows = await tx.$queryRaw<ProviderRow[]>`
        UPDATE external_provider SET
          full_name     = CASE WHEN ${keep(p.fullName)} THEN full_name ELSE ${p.fullName ?? null} END,
          npi           = CASE WHEN ${keep(p.npi)} THEN npi ELSE ${p.npi ?? null} END,
          specialty     = CASE WHEN ${keep(p.specialty)} THEN specialty ELSE ${p.specialty ?? null} END,
          practice_name = CASE WHEN ${keep(p.practiceName)} THEN practice_name ELSE ${p.practiceName ?? null} END,
          phone         = CASE WHEN ${keep(p.phone)} THEN phone ELSE ${p.phone ?? null} END,
          fax           = CASE WHEN ${keep(p.fax)} THEN fax ELSE ${p.fax ?? null} END,
          updated_at = now()
        WHERE id = ${args.providerId}::uuid AND org_id = ${args.orgId}::uuid
        RETURNING id, full_name, npi, specialty, practice_name, phone, fax
      `;
    } catch (err) {
      // external_provider's only unique index besides the key is
      // external_provider_org_npi_uniq: the NPI clash the pre-check above
      // lost a race on (audit R30).
      if (isUniqueViolation(err)) {
        throw new ValidationError("Another provider on your roster already has that NPI. Link that entry instead.");
      }
      throw err;
    }
    if (!rows[0]) throw new NotFoundError("Provider not found.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "external_provider_change",
      targetType: "external_provider",
      targetId: args.providerId,
      payload: { op: "update", fields: providerColumns(p) },
    });
    return rowToProvider(rows[0]);
  });
}

interface LinkRow extends ProviderRow {
  link_id: string;
  role: ExternalProviderRole;
  role_label: string | null;
}

/** PCP, referring, specialists by label, other — the note header's order. */
export async function listPatientProviders(args: {
  orgId: string;
  patientId: string;
}): Promise<PatientProviderView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    await assertPatientInOrg(tx, args.orgId, args.patientId);
    const rows = await tx.$queryRaw<LinkRow[]>`
      SELECT l.id AS link_id, l.role, l.role_label,
             p.id, p.full_name, p.npi, p.specialty, p.practice_name, p.phone, p.fax
        FROM patient_external_provider l
        JOIN external_provider p ON p.id = l.external_provider_id AND p.org_id = l.org_id
       WHERE l.patient_id = ${args.patientId}::uuid
         AND l.org_id = ${args.orgId}::uuid
       ORDER BY CASE l.role WHEN 'primary_care' THEN 0 WHEN 'referring' THEN 1
                            WHEN 'specialist' THEN 2 ELSE 3 END,
                lower(COALESCE(l.role_label, '')), lower(p.full_name), l.id
    `;
    return rows.map((r) => ({
      linkId: r.link_id,
      role: r.role,
      roleLabel: r.role_label,
      provider: rowToProvider(r),
    }));
  });
}

export async function linkPatientProvider(args: {
  orgId: string;
  userId: string;
  patientId: string;
  input: LinkExternalProvider;
}): Promise<{ linkId: string; providerId: string; providerCreated: boolean }> {
  const i = args.input;
  return withOrgContext(args.orgId, async (tx) => {
    await assertPatientInOrg(tx, args.orgId, args.patientId);
    // Refuse a second PCP or referrer before anything is added to the roster.
    const taken = ROLE_TAKEN[i.role];
    if (taken) {
      const held = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM patient_external_provider
         WHERE patient_id = ${args.patientId}::uuid AND role = ${i.role}
           AND org_id = ${args.orgId}::uuid
         LIMIT 1
      `;
      if (held[0]) throw new ValidationError(taken);
    }

    let providerId: string;
    let providerCreated = false;
    if (i.externalProviderId) {
      // Another org's roster row is not found, never linked: by RLS, and by
      // the org named here for a connection that bypasses it.
      const found = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM external_provider
         WHERE id = ${i.externalProviderId}::uuid AND org_id = ${args.orgId}::uuid
         LIMIT 1
      `;
      if (!found[0]) throw new NotFoundError("Provider not found.");
      providerId = found[0].id;
    } else if (i.provider) {
      const r = await resolveOrCreateProvider(tx, { orgId: args.orgId, userId: args.userId, input: i.provider });
      providerId = r.id;
      providerCreated = r.created;
    } else {
      // The schema already refuses this; kept so the service stands alone.
      throw new ValidationError("Pick a provider from your roster, or describe a new one.");
    }

    const { linkId } = await insertPatientProviderLink(tx, {
      orgId: args.orgId,
      userId: args.userId,
      patientId: args.patientId,
      providerId,
      role: i.role,
      roleLabel: i.roleLabel ?? null,
    });
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "patient_provider_change",
      targetType: "patient",
      targetId: args.patientId,
      payload: { linkId, providerId, op: "link", role: i.role, providerCreated },
    });
    return { linkId, providerId, providerCreated };
  });
}

/** Unlinks only. The roster row stays for every other patient that links it. */
export async function unlinkPatientProvider(args: {
  orgId: string;
  userId: string;
  patientId: string;
  linkId: string;
}): Promise<{ unlinked: true }> {
  return withOrgContext(args.orgId, async (tx) => {
    await assertPatientInOrg(tx, args.orgId, args.patientId);
    const rows = await tx.$queryRaw<{ id: string; role: string; external_provider_id: string }[]>`
      DELETE FROM patient_external_provider
       WHERE id = ${args.linkId}::uuid AND patient_id = ${args.patientId}::uuid
         AND org_id = ${args.orgId}::uuid
      RETURNING id, role, external_provider_id
    `;
    if (!rows[0]) throw new NotFoundError("That provider is not linked to this patient.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "patient_provider_change",
      targetType: "patient",
      targetId: args.patientId,
      payload: {
        linkId: args.linkId,
        providerId: rows[0].external_provider_id,
        op: "unlink",
        role: rows[0].role,
      },
    });
    return { unlinked: true };
  });
}
