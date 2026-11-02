/**
 * A patient's record as a C-CDA document (0128): the same read the PDF export
 * makes, written as a CCD another EHR can import. Whole-chart PHI leaving the
 * platform, so it goes on the §164.528 accounting log like the PDF.
 *
 * Visits that did not happen stay out: a cancelled visit or a no-show is not an
 * encounter. A PCM/CCM month carries a bill and was no visit either.
 */
import { randomUUID } from "node:crypto";

import { withOrgContext } from "@/lib/db";
import { orgLocalDate } from "@/lib/features/org/org-date";
import { CARE_MANAGEMENT_VISIT_TYPE } from "@/lib/features/visits/visit.types";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import { buildCcd, ccdVitals, type CcdInput } from "./ccda";
import { readPatientRecord, type RecordVisit } from "./patient-export.service";

const NOT_HELD = new Set(["cancelled", "no_show"]);

type Rec = Awaited<ReturnType<typeof readPatientRecord>>;

const visitAt = (v: RecordVisit) => v.start_time ?? v.scheduled_start;

const sexOf = (s: string | null | undefined): CcdInput["patient"]["sex"] => (s === "F" || s === "M" ? s : "U");

/** The chart, in the shape the document is written from. Pure. */
export function ccdFromRecord(a: {
  rec: Rec;
  documentId: string;
  now: Date;
  org: CcdInput["org"];
  author: CcdInput["author"];
}): CcdInput {
  const { rec, now } = a;
  const tz = rec.timeZone;
  const p = rec.patient;
  const held = rec.visits.filter((v) => !NOT_HELD.has(v.status) && v.visit_type !== CARE_MANAGEMENT_VISIT_TYPE && visitAt(v));
  const dayOf = (v: RecordVisit) => orgLocalDate(visitAt(v)!, tz);
  const label = (v: RecordVisit) => v.visit_type_label ?? v.visit_type.replace(/_/g, " ");
  const made = held.filter((v) => v.status !== "scheduled");
  const days = new Map(held.map((v) => [v.id, dayOf(v)]));
  const fallbackId = (id: string | undefined, n: number, kind: string) => id ?? `${a.documentId}-${kind}-${n}`;
  return {
    documentId: a.documentId,
    now,
    org: a.org,
    author: a.author,
    patient: {
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      dateOfBirth: p.date_of_birth.toISOString().slice(0, 10),
      sex: sexOf(p.sex_assigned_at_birth),
      addressLine1: p.address_line_1 ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      zip: p.zip ?? null,
      phone: p.phone ?? null,
      raceCodes: p.race_codes ?? [],
      ethnicity: p.ethnicity_code ?? null,
      language: p.preferred_language ?? null,
    },
    allergies: rec.clinicalLists.allergies.map((x, n) => ({
      id: fallbackId(x.id, n, "allergy"), substance: x.substance, kind: x.kind, reaction: x.reaction, severity: x.severity, status: x.status,
      rxnormCui: x.rxnorm_cui ?? null, recordedOn: x.recorded_on ?? null,
    })),
    noKnownAllergies: rec.clinicalLists.no_known_allergies_at !== null,
    medications: rec.clinicalLists.medications.map((m, n) => ({
      id: fallbackId(m.id, n, "medication"), name: m.name, dose: m.dose, route: m.route, frequency: m.frequency, status: m.status,
      startedOn: m.started_on, stoppedOn: m.stopped_on, rxnormCui: m.rxnorm_cui ?? null,
    })),
    problems: rec.clinicalLists.problems.map((x, n) => ({
      id: fallbackId(x.id, n, "problem"), icd10: x.icd10, description: x.description, status: x.status, onsetOn: x.onset_on, resolvedOn: x.resolved_on,
    })),
    vitals: rec.notes.vitals.flatMap((v) => {
      const day = days.get(v.visit_id);
      return day ? [{ id: v.visit_id, day, values: ccdVitals(v) }] : [];
    }),
    encounters: made.map((v) => ({ id: v.id, day: dayOf(v), label: label(v), cptCodes: v.cpt_codes ?? [] })),
    planned: held.filter((v) => v.status === "scheduled").map((v) => ({ id: v.id, day: dayOf(v), label: label(v) })),
    goals: rec.carePlan?.goals_of_care_summary ?? null,
  };
}

export async function exportPatientCcd(args: { orgId: string; userId: string; patientId: string; now?: Date }): Promise<{ xml: string }> {
  const rec = await readPatientRecord({ orgId: args.orgId, patientId: args.patientId });
  const { org, author } = await withOrgContext(args.orgId, async (tx) => {
    const orgs = await tx.$queryRaw<{ name: string; npi: string | null; line1: string | null; city: string | null; state: string | null; zip: string | null }[]>`
      SELECT COALESCE(NULLIF(b.legal_name, ''), o.name) AS name, ob.npi,
             b.address_line_1 AS line1, b.city, b.state, b.zip
        FROM org o
        LEFT JOIN org_billing_provider b ON b.org_id = o.id
        LEFT JOIN onboarding_status ob ON ob.org_id = o.id
       WHERE o.id = ${args.orgId}::uuid
    `;
    const people = await tx.$queryRaw<{ name: string; npi: string | null }[]>`
      SELECT COALESCE(u.full_name, u.email) AS name, cp.npi
        FROM app_user u
        LEFT JOIN clinician_profile cp ON cp.user_id = u.id AND cp.org_id = ${args.orgId}::uuid
       WHERE u.id = ${args.userId}::uuid
    `;
    return { org: orgs[0], author: people[0] };
  });
  const now = args.now ?? new Date();
  const xml = buildCcd(
    ccdFromRecord({
      rec,
      documentId: randomUUID(),
      now,
      org: { id: args.orgId, name: org?.name ?? "Practice", phone: null, line1: org?.line1 ?? null, city: org?.city ?? null, state: org?.state ?? null, zip: org?.zip ?? null, npi: org?.npi ?? null },
      author: { name: author?.name ?? "Unknown", npi: author?.npi ?? null },
    }),
  );
  await logPhiExport({ orgId: args.orgId, userId: args.userId, exportType: "patient_ccda", patientIds: [args.patientId], byteSize: Buffer.byteLength(xml) });
  return { xml };
}
