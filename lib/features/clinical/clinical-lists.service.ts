/**
 * The chart's problem list, medication list and allergies (0114; Level-1
 * doc:36).
 *
 * Problems are ICD-10-CM codes from the catalog, one active entry per code.
 * A medication is stopped with its day, never deleted. "No known allergies" is
 * a recorded fact, refused while an allergy is active and cleared when one is
 * recorded. Every change is audited with the list, what was done and the
 * field names: never the code, the drug or the substance.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import type {
  AddAllergy,
  AddMedication,
  AddProblem,
  AllergyView,
  ClinicalList,
  ClinicalListsView,
  MedicationView,
  ProblemView,
  UpdateAllergy,
  UpdateMedication,
  UpdateProblem,
} from "./clinical-lists.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

async function patientToday(tx: Tx, orgId: string, patientId: string): Promise<string> {
  const p = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM patient WHERE id = ${patientId}::uuid AND org_id = ${orgId}::uuid
  `;
  if (!p[0]) throw new NotFoundError("Patient not found.");
  return orgToday(await readOrgTimeZone(tx, orgId));
}

const notAfter = (day: string | null | undefined, today: string, what: string) => {
  if (day && day > today) throw new ValidationError(`${what} is after today.`);
};

async function audit(
  tx: Tx,
  a: { orgId: string; userId: string; patientId: string; list: ClinicalList | "no_known_allergies"; op: string; itemId?: string; fields?: string[] },
): Promise<void> {
  await writeAudit(tx, {
    orgId: a.orgId,
    userId: a.userId,
    action: "clinical_list_change",
    targetType: "patient",
    targetId: a.patientId,
    payload: {
      list: a.list,
      op: a.op,
      ...(a.itemId ? { itemId: a.itemId } : {}),
      ...(a.fields ? { fields: a.fields } : {}),
    },
  });
}

const sent = (v: unknown) => v !== undefined;
const changed = (p: Record<string, unknown>) => Object.keys(p).filter((k) => sent(p[k])).sort();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();

export async function getClinicalLists(args: { orgId: string; patientId: string }): Promise<ClinicalListsView> {
  return withOrgContext(args.orgId, async (tx) => {
    const today = await patientToday(tx, args.orgId, args.patientId);
    const problems = await tx.$queryRaw<
      {
        id: string; icd10: string; description: string; status: ProblemView["status"];
        onset_on: string | null; resolved_on: string | null; notes: string | null;
        recorded_by_name: string | null; recorded_at: Date; updated_by_name: string | null; updated_at: Date;
      }[]
    >`
      SELECT p.id, p.icd10, p.description, p.status,
             to_char(p.onset_on, 'YYYY-MM-DD') AS onset_on, to_char(p.resolved_on, 'YYYY-MM-DD') AS resolved_on,
             p.notes, COALESCE(ru.full_name, ru.email) AS recorded_by_name, p.recorded_at,
             COALESCE(uu.full_name, uu.email) AS updated_by_name, p.updated_at
        FROM patient_problem p
        LEFT JOIN app_user ru ON ru.id = p.recorded_by_user_id
        LEFT JOIN app_user uu ON uu.id = p.updated_by_user_id
       WHERE p.patient_id = ${args.patientId}::uuid AND p.org_id = ${args.orgId}::uuid
       ORDER BY (p.status = 'active') DESC, p.recorded_at DESC
    `;
    const medications = await tx.$queryRaw<
      {
        id: string; name: string; dose: string | null; route: string | null; frequency: string | null;
        prn: boolean; indication: string | null; status: MedicationView["status"];
        started_on: string | null; stopped_on: string | null; stop_reason: string | null; rxnorm_cui: string | null;
        recorded_by_name: string | null; recorded_at: Date; updated_by_name: string | null; updated_at: Date;
      }[]
    >`
      SELECT m.id, m.name, m.dose, m.route, m.frequency, m.prn, m.indication, m.status,
             to_char(m.started_on, 'YYYY-MM-DD') AS started_on, to_char(m.stopped_on, 'YYYY-MM-DD') AS stopped_on,
             m.stop_reason, m.rxnorm_cui, COALESCE(ru.full_name, ru.email) AS recorded_by_name, m.recorded_at,
             COALESCE(uu.full_name, uu.email) AS updated_by_name, m.updated_at
        FROM patient_medication m
        LEFT JOIN app_user ru ON ru.id = m.recorded_by_user_id
        LEFT JOIN app_user uu ON uu.id = m.updated_by_user_id
       WHERE m.patient_id = ${args.patientId}::uuid AND m.org_id = ${args.orgId}::uuid
       ORDER BY (m.status = 'active') DESC, m.recorded_at ASC
    `;
    const allergies = await tx.$queryRaw<
      {
        id: string; substance: string; kind: AllergyView["kind"]; reaction: string | null;
        severity: AllergyView["severity"]; status: AllergyView["status"]; inactive_reason: string | null; rxnorm_cui: string | null;
        recorded_by_name: string | null; recorded_at: Date; updated_by_name: string | null; updated_at: Date;
      }[]
    >`
      SELECT a.id, a.substance, a.kind, a.reaction, a.severity, a.status, a.inactive_reason, a.rxnorm_cui,
             COALESCE(ru.full_name, ru.email) AS recorded_by_name, a.recorded_at,
             COALESCE(uu.full_name, uu.email) AS updated_by_name, a.updated_at
        FROM patient_allergy a
        LEFT JOIN app_user ru ON ru.id = a.recorded_by_user_id
        LEFT JOIN app_user uu ON uu.id = a.updated_by_user_id
       WHERE a.patient_id = ${args.patientId}::uuid AND a.org_id = ${args.orgId}::uuid
       ORDER BY (a.status = 'active') DESC, a.recorded_at DESC
    `;
    const nka = await tx.$queryRaw<{ at: Date | null; by_name: string | null }[]>`
      SELECT p.no_known_allergies_at AS at, COALESCE(u.full_name, u.email) AS by_name
        FROM patient p
        LEFT JOIN app_user u ON u.id = p.no_known_allergies_by_user_id
       WHERE p.id = ${args.patientId}::uuid AND p.org_id = ${args.orgId}::uuid
    `;
    return {
      problems: problems.map((r) => ({
        id: r.id, icd10: r.icd10, description: r.description, status: r.status,
        onsetOn: r.onset_on, resolvedOn: r.resolved_on, notes: r.notes,
        recordedByName: r.recorded_by_name, recordedAt: iso(r.recorded_at),
        updatedByName: r.updated_by_name, updatedAt: iso(r.updated_at),
      })),
      medications: medications.map((r) => ({
        id: r.id, name: r.name, dose: r.dose, route: r.route, frequency: r.frequency, prn: r.prn,
        indication: r.indication, status: r.status, startedOn: r.started_on, stoppedOn: r.stopped_on,
        stopReason: r.stop_reason, rxnormCui: r.rxnorm_cui, recordedByName: r.recorded_by_name, recordedAt: iso(r.recorded_at),
        updatedByName: r.updated_by_name, updatedAt: iso(r.updated_at),
      })),
      allergies: allergies.map((r) => ({
        id: r.id, substance: r.substance, kind: r.kind, reaction: r.reaction, severity: r.severity, rxnormCui: r.rxnorm_cui,
        status: r.status, inactiveReason: r.inactive_reason, recordedByName: r.recorded_by_name,
        recordedAt: iso(r.recorded_at), updatedByName: r.updated_by_name, updatedAt: iso(r.updated_at),
      })),
      noKnownAllergies: nka[0]?.at ? { at: iso(nka[0].at), byName: nka[0].by_name } : null,
      practiceToday: today,
    };
  });
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export async function addProblem(args: {
  orgId: string; userId: string; patientId: string; payload: AddProblem;
}): Promise<{ id: string }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const today = await patientToday(tx, args.orgId, args.patientId);
    notAfter(p.onsetOn, today, "The onset");
    // A code in the ICD-10-CM catalog: a well-formed code that is not one is
    // a typo, and the problem list is what a claim and an export read.
    const cat = await tx.$queryRaw<{ code: string; description: string }[]>`
      SELECT code, description FROM icd10
       WHERE replace(upper(code), '.', '') = ${p.icd10.replace(/\./g, "")} AND expiration_date IS NULL
       LIMIT 1
    `;
    if (!cat[0]) throw new ValidationError(`${p.icd10} is not in the ICD-10-CM code set.`);
    const dup = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient_problem
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
         AND icd10 = ${p.icd10} AND status = 'active'
       LIMIT 1
    `;
    if (dup[0]) throw new ValidationError(`${p.icd10} is already on the problem list.`);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_problem (org_id, patient_id, icd10, description, onset_on, notes,
                                   recorded_by_user_id, updated_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${p.icd10},
              ${p.description?.trim() || cat[0].description}, ${p.onsetOn ?? null}::date,
              ${p.notes?.trim() || null}, ${args.userId}::uuid, ${args.userId}::uuid)
      RETURNING id
    `;
    await audit(tx, { orgId: args.orgId, userId: args.userId, patientId: args.patientId, list: "problems", op: "add", itemId: rows[0]!.id });
    return { id: rows[0]!.id };
  });
}

export async function updateProblem(args: {
  orgId: string; userId: string; patientId: string; itemId: string; payload: UpdateProblem;
}): Promise<{ updated: true }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const today = await patientToday(tx, args.orgId, args.patientId);
    const cur = await tx.$queryRaw<{ icd10: string; status: string; onset_on: string | null }[]>`
      SELECT icd10, status, to_char(onset_on, 'YYYY-MM-DD') AS onset_on FROM patient_problem
       WHERE id = ${args.itemId}::uuid AND patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Problem not found.");
    notAfter(p.onsetOn, today, "The onset");
    notAfter(p.resolvedOn, today, "The resolution");
    const onset = p.onsetOn !== undefined ? p.onsetOn : cur[0].onset_on;
    if (p.resolvedOn && onset && p.resolvedOn < onset) throw new ValidationError("It resolved before its onset.");
    // Reopening a problem whose code is active again elsewhere would list it twice.
    if (p.status === "active" && cur[0].status !== "active") {
      const dup = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM patient_problem
         WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
           AND icd10 = ${cur[0].icd10} AND status = 'active' AND id <> ${args.itemId}::uuid
         LIMIT 1
      `;
      if (dup[0]) throw new ValidationError(`${cur[0].icd10} is already active on the problem list.`);
    }
    const resolving = p.status === "resolved";
    const reopening = p.status === "active";
    await tx.$executeRaw`
      UPDATE patient_problem SET
        description = COALESCE(${p.description ?? null}, description),
        onset_on    = CASE WHEN ${sent(p.onsetOn)} THEN ${p.onsetOn ?? null}::date ELSE onset_on END,
        notes       = CASE WHEN ${sent(p.notes)} THEN ${p.notes ?? null} ELSE notes END,
        status      = COALESCE(${p.status ?? null}, status),
        resolved_on = CASE WHEN ${resolving} THEN ${p.resolvedOn ?? null}::date
                           WHEN ${reopening} THEN NULL
                           WHEN ${sent(p.resolvedOn)} AND status = 'resolved' THEN ${p.resolvedOn ?? null}::date
                           ELSE resolved_on END,
        updated_by_user_id = ${args.userId}::uuid,
        updated_at  = now()
      WHERE id = ${args.itemId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await audit(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId, list: "problems",
      op: resolving ? "resolve" : reopening ? "reopen" : "edit", itemId: args.itemId, fields: changed(p),
    });
    return { updated: true };
  });
}

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

export async function addMedication(args: {
  orgId: string; userId: string; patientId: string; payload: AddMedication;
}): Promise<{ id: string }> {
  const m = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const today = await patientToday(tx, args.orgId, args.patientId);
    notAfter(m.startedOn, today, "The start");
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_medication (org_id, patient_id, name, dose, route, frequency, prn, indication,
                                      started_on, rxnorm_cui, recorded_by_user_id, updated_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${m.name.trim()}, ${m.dose?.trim() || null},
              ${m.route?.trim() || null}, ${m.frequency?.trim() || null}, ${m.prn ?? false},
              ${m.indication?.trim() || null}, ${m.startedOn ?? null}::date, ${m.rxnormCui ?? null}, ${args.userId}::uuid, ${args.userId}::uuid)
      RETURNING id
    `;
    await audit(tx, { orgId: args.orgId, userId: args.userId, patientId: args.patientId, list: "medications", op: "add", itemId: rows[0]!.id });
    return { id: rows[0]!.id };
  });
}

export async function updateMedication(args: {
  orgId: string; userId: string; patientId: string; itemId: string; payload: UpdateMedication;
}): Promise<{ updated: true }> {
  const m = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const today = await patientToday(tx, args.orgId, args.patientId);
    const cur = await tx.$queryRaw<{ status: string; started_on: string | null }[]>`
      SELECT status, to_char(started_on, 'YYYY-MM-DD') AS started_on FROM patient_medication
       WHERE id = ${args.itemId}::uuid AND patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Medication not found.");
    notAfter(m.startedOn, today, "The start");
    notAfter(m.stoppedOn, today, "The stop");
    const started = m.startedOn !== undefined ? m.startedOn : cur[0].started_on;
    if (m.stoppedOn && started && m.stoppedOn < started) throw new ValidationError("It was stopped before it started.");
    const stopping = m.status === "stopped";
    const restarting = m.status === "active";
    await tx.$executeRaw`
      UPDATE patient_medication SET
        name        = COALESCE(${m.name ?? null}, name),
        dose        = CASE WHEN ${sent(m.dose)} THEN ${m.dose ?? null} ELSE dose END,
        route       = CASE WHEN ${sent(m.route)} THEN ${m.route ?? null} ELSE route END,
        frequency   = CASE WHEN ${sent(m.frequency)} THEN ${m.frequency ?? null} ELSE frequency END,
        prn         = COALESCE(${m.prn ?? null}::boolean, prn),
        indication  = CASE WHEN ${sent(m.indication)} THEN ${m.indication ?? null} ELSE indication END,
        started_on  = CASE WHEN ${sent(m.startedOn)} THEN ${m.startedOn ?? null}::date ELSE started_on END,
        rxnorm_cui  = CASE WHEN ${sent(m.rxnormCui)} THEN ${m.rxnormCui ?? null} ELSE rxnorm_cui END,
        status      = COALESCE(${m.status ?? null}, status),
        stopped_on  = CASE WHEN ${stopping} THEN ${m.stoppedOn ?? null}::date
                           WHEN ${restarting} THEN NULL ELSE stopped_on END,
        stop_reason = CASE WHEN ${stopping} THEN ${m.stopReason ?? null}
                           WHEN ${restarting} THEN NULL ELSE stop_reason END,
        updated_by_user_id = ${args.userId}::uuid,
        updated_at  = now()
      WHERE id = ${args.itemId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await audit(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId, list: "medications",
      op: stopping ? "stop" : restarting ? "restart" : "edit", itemId: args.itemId, fields: changed(m),
    });
    return { updated: true };
  });
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export async function addAllergy(args: {
  orgId: string; userId: string; patientId: string; payload: AddAllergy;
}): Promise<{ id: string }> {
  const a = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    await patientToday(tx, args.orgId, args.patientId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_allergy (org_id, patient_id, substance, kind, reaction, severity, rxnorm_cui,
                                   recorded_by_user_id, updated_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${a.substance.trim()}, ${a.kind},
              ${a.reaction?.trim() || null}, ${a.severity ?? null}, ${a.rxnormCui ?? null}, ${args.userId}::uuid, ${args.userId}::uuid)
      RETURNING id
    `;
    // An allergy recorded means "no known allergies" no longer holds.
    await tx.$executeRaw`
      UPDATE patient SET no_known_allergies_at = NULL, no_known_allergies_by_user_id = NULL
       WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND no_known_allergies_at IS NOT NULL
    `;
    await audit(tx, { orgId: args.orgId, userId: args.userId, patientId: args.patientId, list: "allergies", op: "add", itemId: rows[0]!.id });
    return { id: rows[0]!.id };
  });
}

export async function updateAllergy(args: {
  orgId: string; userId: string; patientId: string; itemId: string; payload: UpdateAllergy;
}): Promise<{ updated: true }> {
  const a = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    await patientToday(tx, args.orgId, args.patientId);
    const cur = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM patient_allergy
       WHERE id = ${args.itemId}::uuid AND patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Allergy not found.");
    const inactivating = a.status === "inactive";
    const reactivating = a.status === "active";
    await tx.$executeRaw`
      UPDATE patient_allergy SET
        substance = COALESCE(${a.substance ?? null}, substance),
        kind      = COALESCE(${a.kind ?? null}, kind),
        reaction  = CASE WHEN ${sent(a.reaction)} THEN ${a.reaction ?? null} ELSE reaction END,
        severity  = CASE WHEN ${sent(a.severity)} THEN ${a.severity ?? null} ELSE severity END,
        status    = COALESCE(${a.status ?? null}, status),
        inactive_reason = CASE WHEN ${inactivating} THEN ${a.inactiveReason ?? null}
                               WHEN ${reactivating} THEN NULL ELSE inactive_reason END,
        updated_by_user_id = ${args.userId}::uuid,
        updated_at = now()
      WHERE id = ${args.itemId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (reactivating) {
      await tx.$executeRaw`
        UPDATE patient SET no_known_allergies_at = NULL, no_known_allergies_by_user_id = NULL
         WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND no_known_allergies_at IS NOT NULL
      `;
    }
    await audit(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId, list: "allergies",
      op: inactivating ? "inactivate" : reactivating ? "reactivate" : "edit", itemId: args.itemId, fields: changed(a),
    });
    return { updated: true };
  });
}

/** Record "no known allergies", as asked and answered, not as an empty list. */
export async function setNoKnownAllergies(args: { orgId: string; userId: string; patientId: string }): Promise<void> {
  return withOrgContext(args.orgId, async (tx) => {
    await patientToday(tx, args.orgId, args.patientId);
    const active = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM patient_allergy
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND status = 'active'
    `;
    if (Number(active[0]?.n ?? 0) > 0) {
      throw new ValidationError("An allergy is recorded as active. Mark it inactive first if it was entered in error.");
    }
    await tx.$executeRaw`
      UPDATE patient SET no_known_allergies_at = now(), no_known_allergies_by_user_id = ${args.userId}::uuid
       WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await audit(tx, { orgId: args.orgId, userId: args.userId, patientId: args.patientId, list: "no_known_allergies", op: "record" });
  });
}
