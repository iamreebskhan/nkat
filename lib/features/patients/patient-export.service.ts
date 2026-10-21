/**
 * Per-patient record export — HIPAA right of access (45 CFR §164.524).
 *
 * Renders the patient chart (demographics, care plan, visits with their signed
 * notes, and superbills) as a branded PDF. Triggers a phi_export_log row.
 *
 * Designation §164.524(c)(2)(ii): a covered entity must provide access
 * within 30 calendar days. Self-serve PDF satisfies that for
 * patient-requested records routed through the org's portal flow,
 * and gives an org admin a one-click way to fulfill walk-in requests.
 *
 * Audit R28: this was the one document an org hands out as the designated
 * record set, and it contained no clinical note at all — visits were a table
 * of codes. It had no key tying a bill to its visit, and only page 1
 * identified the patient. Signed notes (with their addenda and attestation)
 * are now included; every visit and bill carries the full visit ID; and every
 * page footer names the patient.
 *
 * Audit R30: the patient's family and caregivers (and who holds healthcare
 * POA) and their outside providers belong to the designated record set too,
 * and are now included.
 */
import puppeteer, { type Browser } from "puppeteer";

import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { orgLocalDate } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import {
  escapeHtml,
  renderAddendaHtml,
  renderAttestationLine,
  renderLegacyNoteHtml,
  renderSectionHtml,
  renderVitalsRows,
  type RenderableAddendum,
} from "@/lib/features/visits/note-render";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import {
  CONTACT_RELATIONSHIP_LABELS,
  EXTERNAL_PROVIDER_ROLE_LABELS,
  type ContactRelationship,
  type ExternalProviderRole,
} from "./contacts.types";

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

export interface PatientExportInput {
  orgId: string;
  userId: string;
  patientId: string;
  orgName: string;
  primaryColor?: string | null;
  logoUrl?: string | null;
}

export interface PatientExportResult {
  pdfBytes: Buffer;
  patientName: string;
}

export interface RecordPatient {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: Date;
  primary_payer_name: string | null;
  primary_member_id: string | null;
}

export interface RecordVisit {
  id: string;
  visit_type: string;
  visit_type_label: string | null;
  status: string;
  scheduled_start: Date | null;
  start_time: Date | null;
  total_minutes: number | null;
  cpt_codes: string[] | null;
  icd10_codes: string[] | null;
  signed_at: Date | null;
  signed_by_user_id: string | null;
  clinician_user_id: string | null;
  signer_name: string | null;
  signer_credential: string | null;
  /** The pre-sectioned note, for visits written before 0088. */
  document_text: string | null;
}

export interface RecordSuperbill {
  id: string;
  visit_id: string;
  status: string;
  date_of_service: Date;
  cpt_codes: string[] | null;
  billed_amount_cents: bigint | number;
  paid_amount_cents: bigint | number | null;
}

export interface RecordSection {
  visit_id: string;
  label: string;
  kind: "prose" | "list" | "vitals";
  content: unknown;
  is_empty: boolean;
  carried_unchanged: boolean;
}

export interface RecordNotes {
  sections: RecordSection[];
  vitals: (Record<string, unknown> & { visit_id: string })[];
  addenda: (RenderableAddendum & { visit_id: string })[];
}

export interface RecordCarePlan {
  goals_of_care_summary: string | null;
  updated_at: Date;
}

/** A family member or caregiver on file (audit R30). */
export interface RecordContact {
  full_name: string;
  relationship: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  is_primary_caregiver: boolean;
  is_emergency_contact: boolean;
  is_healthcare_poa: boolean;
  lives_with_patient: boolean;
  notes: string | null;
}

/** An outside provider linked to the patient (audit R30). */
export interface RecordProvider {
  role: string;
  role_label: string | null;
  full_name: string;
  npi: string | null;
  specialty: string | null;
  practice_name: string | null;
  phone: string | null;
  fax: string | null;
}

export interface RecordCareTeam {
  contacts: RecordContact[];
  providers: RecordProvider[];
}

/** Only an attested note is part of the record set; drafts stay in the table. */
const SIGNED = new Set(["documented", "pending_billing", "billed"]);

export async function exportPatientRecord(
  input: PatientExportInput,
): Promise<PatientExportResult> {
  const data = await withOrgContext(input.orgId, async (tx) => {
    // Every read of the record names the org as well as relying on RLS: on a
    // connection that bypasses RLS a patient id alone exported another org's
    // chart, and a patient id shared by two orgs' rows merged them.
    const patientRows = await tx.$queryRaw<RecordPatient[]>`
      SELECT p.id, p.first_name, p.last_name, p.date_of_birth,
             pa.name AS primary_payer_name, p.primary_member_id
      FROM patient p
      LEFT JOIN payer pa ON pa.id = p.primary_payer_id
      WHERE p.id = ${input.patientId}::uuid
        AND p.org_id = ${input.orgId}::uuid
      LIMIT 1
    `;
    const patient = patientRows[0];
    if (!patient) throw new NotFoundError("Patient not found.");

    // Visits are dated on the practice's days (0107), not their UTC days.
    const timeZone = await readOrgTimeZone(tx, input.orgId);

    const visits = await tx.$queryRaw<RecordVisit[]>`
      SELECT v.id, v.visit_type, t.label AS visit_type_label, v.status,
             v.scheduled_start, v.start_time, v.total_minutes,
             v.cpt_codes_assigned AS cpt_codes, v.icd10_codes,
             v.signed_at, v.signed_by_user_id, v.clinician_user_id, v.signer_credential,
             su.full_name AS signer_name, v.document_text
      FROM visit v
      LEFT JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
      LEFT JOIN app_user su ON su.id = v.signed_by_user_id
      WHERE v.patient_id = ${input.patientId}::uuid
        AND v.org_id = ${input.orgId}::uuid
      ORDER BY COALESCE(v.start_time, v.scheduled_start, v.created_at) DESC
      LIMIT 200
    `;

    // The signed notes' sections, with the same template-pin fallback the
    // packet and the sign guard use (a visit whose org had no active template
    // when its note was written or signed has no pin).
    const sections = await tx.$queryRaw<RecordSection[]>`
      SELECT s.visit_id, t.label, t.kind, s.content,
             COALESCE(s.is_empty, TRUE) AS is_empty,
             COALESCE(s.carried_unchanged, FALSE) AS carried_unchanged
        FROM visit_note_section s
        JOIN visit v ON v.id = s.visit_id AND v.org_id = s.org_id
        JOIN note_template_section t
          ON t.section_key = s.section_key
         AND t.org_id = v.org_id
         AND t.template_id = COALESCE(
               v.note_template_id,
               (SELECT nt.id FROM note_template nt
                 WHERE nt.org_id = v.org_id AND nt.is_active LIMIT 1))
       WHERE v.patient_id = ${input.patientId}::uuid
         AND v.org_id = ${input.orgId}::uuid
         AND v.status IN ('documented', 'pending_billing', 'billed')
       ORDER BY s.visit_id, t.sort_order
    `;

    const vitals = await tx.$queryRaw<(Record<string, unknown> & { visit_id: string })[]>`
      SELECT visit_id, weight_kg, height_cm, bp_systolic, bp_diastolic, heart_rate,
             resp_rate, temperature_c, spo2_percent, pps_percent, pain_score
        FROM visit_vitals
       WHERE patient_id = ${input.patientId}::uuid
         AND org_id = ${input.orgId}::uuid
    `;

    const addenda = await tx.$queryRaw<(RenderableAddendum & { visit_id: string })[]>`
      SELECT a.visit_id, a.body, a.author_credential, a.signed_at,
             u.full_name AS author_name
        FROM visit_addendum a
        JOIN visit v ON v.id = a.visit_id AND v.org_id = a.org_id
        LEFT JOIN app_user u ON u.id = a.author_user_id
       WHERE v.patient_id = ${input.patientId}::uuid
         AND v.org_id = ${input.orgId}::uuid
       ORDER BY a.signed_at, a.id
    `;

    const superbills = await tx.$queryRaw<RecordSuperbill[]>`
      SELECT id, visit_id, status, date_of_service, cpt_codes,
             billed_amount_cents, paid_amount_cents
      FROM superbill
      WHERE patient_id = ${input.patientId}::uuid
        AND org_id = ${input.orgId}::uuid
      ORDER BY date_of_service DESC
      LIMIT 200
    `;

    const carePlanRows = await tx.$queryRaw<RecordCarePlan[]>`
      SELECT goals_of_care_summary, updated_at FROM care_plan
      WHERE patient_id = ${input.patientId}::uuid
        AND org_id = ${input.orgId}::uuid
      LIMIT 1
    `;

    // Family, caregivers and outside providers (audit R30), in the order the
    // chart shows them.
    const contacts = await tx.$queryRaw<RecordContact[]>`
      SELECT full_name, relationship, phone, alt_phone, email,
             is_primary_caregiver, is_emergency_contact, is_healthcare_poa,
             lives_with_patient, notes
        FROM patient_contact
       WHERE patient_id = ${input.patientId}::uuid
         AND org_id = ${input.orgId}::uuid
       ORDER BY is_healthcare_poa DESC, is_primary_caregiver DESC,
                is_emergency_contact DESC, lower(full_name)
    `;
    const providers = await tx.$queryRaw<RecordProvider[]>`
      SELECT l.role, l.role_label, ep.full_name, ep.npi, ep.specialty,
             ep.practice_name, ep.phone, ep.fax
        FROM patient_external_provider l
        JOIN external_provider ep ON ep.id = l.external_provider_id AND ep.org_id = l.org_id
       WHERE l.patient_id = ${input.patientId}::uuid
         AND l.org_id = ${input.orgId}::uuid
       ORDER BY CASE l.role WHEN 'primary_care' THEN 0 WHEN 'referring' THEN 1
                            WHEN 'specialist' THEN 2 ELSE 3 END,
                lower(COALESCE(l.role_label, '')), lower(ep.full_name)
    `;

    return {
      timeZone,
      patient,
      visits,
      superbills,
      carePlan: carePlanRows[0] ?? null,
      notes: { sections, vitals, addenda },
      careTeam: { contacts, providers },
    };
  });

  const html = renderPatientRecordHtml(
    { orgName: input.orgName, primaryColor: input.primaryColor, timeZone: data.timeZone },
    data.patient,
    data.visits,
    data.superbills,
    data.carePlan,
    data.notes,
    data.careTeam,
  );

  const p = data.patient;
  const browser = await getBrowser();
  const page = await browser.newPage();
  let pdfBytes: Buffer;
  try {
    // domcontentloaded is sufficient — the HTML is fully inline (no
    // external CSS / JS / images). A 200-visit chart with notes takes a while.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const result = await page.pdf({
      format: "Letter",
      margin: { top: "0.5in", bottom: "0.6in", left: "0.5in", right: "0.5in" },
      printBackground: true,
      // Every page names the patient (audit R28): only page 1 used to.
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="font-size:8px;color:#64748b;width:100%;padding:0 0.5in;display:flex;justify-content:space-between;">' +
        `<span>${escapeHtml(p.last_name)}, ${escapeHtml(p.first_name)} · Member ID ${escapeHtml(p.primary_member_id ?? "—")}</span>` +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    });
    pdfBytes = Buffer.from(result);
  } finally {
    await page.close();
  }

  void logPhiExport({
    orgId: input.orgId,
    userId: input.userId,
    exportType: "patient_record_pdf",
    patientIds: [input.patientId],
    byteSize: pdfBytes.byteLength,
  });

  return {
    pdfBytes,
    patientName: `${p.first_name} ${p.last_name}`,
  };
}

const prettySlug = (s: string) => s.replace(/_/g, " ");
/** A visit's start is an instant: its day where the practice is (0107). */
const visitDate = (v: RecordVisit, timeZone: string) => {
  const at = v.start_time ?? v.scheduled_start;
  return at ? orgLocalDate(at, timeZone) : "—";
};
const money = (c: bigint | number) => `$${(Number(c) / 100).toFixed(2)}`;

/**
 * The record as HTML. Pure, so what the PDF contains is testable without a
 * browser. `timeZone` is org.timezone: visit dates are the practice's days.
 */
export function renderPatientRecordHtml(
  meta: { orgName: string; primaryColor?: string | null; generatedAt?: Date; timeZone: string },
  p: RecordPatient,
  visits: RecordVisit[],
  superbills: RecordSuperbill[],
  carePlan: RecordCarePlan | null,
  notes: RecordNotes,
  careTeam: RecordCareTeam = { contacts: [], providers: [] },
): string {
  const primary = meta.primaryColor ?? "#0d9488";
  const generatedAt =
    (meta.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 19) + "Z";
  const dob = p.date_of_birth.toISOString().slice(0, 10);

  const signed = visits.filter((v) => SIGNED.has(v.status));
  const notesHtml = signed
    .map((v) => {
      const sections = notes.sections
        .filter((s) => s.visit_id === v.id && !s.is_empty && s.kind !== "vitals")
        .map((s) => {
          const inner = renderSectionHtml(s.kind, s.content);
          if (!inner) return "";
          const flag = s.carried_unchanged
            ? ' <span class="flag">carried forward, unedited</span>'
            : "";
          return `<div class="sec"><h4>${escapeHtml(s.label)}${flag}</h4>${inner}</div>`;
        })
        .join("");
      const vitalsRows = renderVitalsRows(notes.vitals.find((x) => x.visit_id === v.id) ?? null);
      const vitals = vitalsRows
        ? `<div class="sec"><h4>Vitals</h4><table class="kv">${vitalsRows}</table></div>`
        : "";
      const body =
        sections + vitals ||
        renderLegacyNoteHtml(v.document_text) ||
        `<p class="empty">No note recorded.</p>`;
      return `<div class="visit-note">
        <h3>${visitDate(v, meta.timeZone)} · ${escapeHtml(v.visit_type_label ?? prettySlug(v.visit_type))}</h3>
        <p class="ref">Visit ID <span class="mono">${escapeHtml(v.id)}</span></p>
        ${body}
        ${renderAddendaHtml(notes.addenda.filter((a) => a.visit_id === v.id), meta.timeZone)}
        ${renderAttestationLine({
          signerName: v.signer_name,
          signerCredential: v.signer_credential,
          signedAt: v.signed_at,
          signedByUserId: v.signed_by_user_id,
          clinicianUserId: v.clinician_user_id,
          timeZone: meta.timeZone,
        })}
      </div>`;
    })
    .join("");

  // Family & caregivers and outside providers (audit R30).
  const { contacts, providers } = careTeam;
  const contactRoles = (c: RecordContact) =>
    [
      c.is_healthcare_poa && "Healthcare POA",
      c.is_primary_caregiver && "Primary caregiver",
      c.is_emergency_contact && "Emergency contact",
      c.lives_with_patient && "Lives with patient",
    ]
      .filter(Boolean)
      .join(", ");
  const contactsHtml =
    contacts.length === 0
      ? `<p style="color:#64748b">None on file.</p>`
      : `<table>
    <thead><tr><th>Name</th><th>Relationship</th><th>Phone</th><th>Email</th><th>Roles</th><th>Notes</th></tr></thead>
    <tbody>
      ${contacts
        .map(
          (c) => `<tr>
        <td>${escapeHtml(c.full_name)}</td>
        <td>${escapeHtml(CONTACT_RELATIONSHIP_LABELS[c.relationship as ContactRelationship] ?? prettySlug(c.relationship))}</td>
        <td class="mono">${escapeHtml([c.phone, c.alt_phone].filter(Boolean).join(" / ") || "—")}</td>
        <td>${escapeHtml(c.email ?? "—")}</td>
        <td>${escapeHtml(contactRoles(c) || "—")}</td>
        <td style="white-space:pre-wrap">${escapeHtml(c.notes ?? "")}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
  const providerRole = (r: RecordProvider) =>
    (r.role === "specialist" || r.role === "other") && r.role_label
      ? r.role_label
      : (EXTERNAL_PROVIDER_ROLE_LABELS[r.role as ExternalProviderRole] ?? prettySlug(r.role));
  const providersHtml =
    providers.length === 0
      ? `<p style="color:#64748b">None on file.</p>`
      : `<table>
    <thead><tr><th>Role</th><th>Name</th><th>NPI</th><th>Specialty</th><th>Practice</th><th>Phone</th><th>Fax</th></tr></thead>
    <tbody>
      ${providers
        .map(
          (r) => `<tr>
        <td>${escapeHtml(providerRole(r))}</td>
        <td>${escapeHtml(r.full_name)}</td>
        <td class="mono">${escapeHtml(r.npi ?? "—")}</td>
        <td>${escapeHtml(r.specialty ?? "—")}</td>
        <td>${escapeHtml(r.practice_name ?? "—")}</td>
        <td class="mono">${escapeHtml(r.phone ?? "—")}</td>
        <td class="mono">${escapeHtml(r.fax ?? "—")}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; font-size: 11px; color: #0f172a; margin: 0; }
  .header { display:flex; justify-content:space-between; align-items:baseline; border-bottom: 2px solid ${primary}; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-size: 18px; font-weight: 700; color: ${primary}; }
  h2 { font-size: 14px; margin: 18px 0 6px; border-left: 3px solid ${primary}; padding-left: 8px; }
  h3 { font-size: 12px; margin: 14px 0 2px; }
  h4 { font-size: 11px; margin: 8px 0 2px; color: #334155; }
  table { width:100%; border-collapse: collapse; margin-bottom: 8px; }
  th { font-size: 9px; text-transform: uppercase; color: #64748b; padding: 4px 6px; border-bottom: 1px solid #e2e8f0; text-align: left; }
  td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .mono { font-family: 'JetBrains Mono', monospace; }
  .id { font-family: 'JetBrains Mono', monospace; font-size: 8px; }
  .ref { font-size: 9px; color: #64748b; margin: 0 0 4px; }
  .sec p { margin: 2px 0; }
  .sec ul, .sec ol { margin: 2px 0 2px 16px; padding: 0; }
  .kv td { border: 0; padding: 1px 6px; }
  .empty { color: #94a3b8; font-style: italic; }
  .flag { font-size: 8px; text-transform: uppercase; color: #b45309; }
  .visit-note { page-break-inside: auto; border-top: 1px solid #e2e8f0; padding-top: 4px; }
  .footer { font-size: 9px; color: #64748b; margin-top: 18px; padding-top: 8px; border-top: 1px solid #e2e8f0; }
</style>
</head><body>
  <div class="header">
    <div>
      <div class="brand">${escapeHtml(meta.orgName)}</div>
      <div style="font-size:10px;color:#64748b">Patient record export</div>
    </div>
    <div style="font-size:10px;color:#475569;text-align:right">
      <div>Generated ${generatedAt}</div>
      <div>Per HIPAA §164.524 (right of access)</div>
    </div>
  </div>

  <h2>Patient</h2>
  <table>
    <tr><th style="width:40%">Name</th><td>${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</td></tr>
    <tr><th>DOB</th><td class="mono">${dob}</td></tr>
    <tr><th>Primary payer</th><td>${escapeHtml(p.primary_payer_name ?? "—")}</td></tr>
    <tr><th>Member ID</th><td class="mono">${escapeHtml(p.primary_member_id ?? "—")}</td></tr>
  </table>

  <h2>Family &amp; caregivers (${contacts.length})</h2>
  ${contactsHtml}

  <h2>Outside providers (${providers.length})</h2>
  ${providersHtml}

  ${carePlan ? `
  <h2>Care plan</h2>
  <p style="font-size:10px;color:#64748b;margin:0 0 4px">Last updated ${orgLocalDate(carePlan.updated_at, meta.timeZone)}</p>
  <p style="white-space:pre-wrap">${escapeHtml(carePlan.goals_of_care_summary ?? "(no summary)")}</p>
  ` : ""}

  <h2>Visits (${visits.length})</h2>
  ${visits.length === 0 ? `<p style="color:#64748b">No visits recorded.</p>` : `
  <table>
    <thead><tr>
      <th>Visit ID</th><th>Date</th><th>Type</th><th>Status</th><th>Min</th><th>CPT</th><th>ICD-10</th>
    </tr></thead>
    <tbody>
      ${visits.map((v) => `<tr>
          <td class="id">${escapeHtml(v.id)}</td>
          <td class="mono">${visitDate(v, meta.timeZone)}</td>
          <td>${escapeHtml(v.visit_type_label ?? prettySlug(v.visit_type))}</td>
          <td>${escapeHtml(prettySlug(v.status))}</td>
          <td class="mono">${v.total_minutes ?? "—"}</td>
          <td class="mono">${escapeHtml((v.cpt_codes ?? []).join(", "))}</td>
          <td class="mono">${escapeHtml((v.icd10_codes ?? []).join(", "))}</td>
        </tr>`).join("")}
    </tbody>
  </table>`}

  <h2>Visit notes</h2>
  ${signed.length === 0
    ? `<p style="color:#64748b">No signed notes. Notes still being written are not part of the record set.</p>`
    : notesHtml}

  <h2>Superbills (${superbills.length})</h2>
  ${superbills.length === 0 ? `<p style="color:#64748b">None.</p>` : `
  <table>
    <thead><tr>
      <th>Visit ID</th><th>DOS</th><th>Status</th><th>CPT</th><th style="text-align:right">Billed</th><th style="text-align:right">Paid</th>
    </tr></thead>
    <tbody>
      ${superbills.map((s) => `<tr>
        <td class="id">${escapeHtml(s.visit_id)}</td>
        <td class="mono">${s.date_of_service.toISOString().slice(0, 10)}</td>
        <td>${escapeHtml(prettySlug(s.status))}</td>
        <td class="mono">${escapeHtml((s.cpt_codes ?? []).join(", "))}</td>
        <td class="mono" style="text-align:right">${money(s.billed_amount_cents)}</td>
        <td class="mono" style="text-align:right">${s.paid_amount_cents != null ? money(s.paid_amount_cents) : "—"}</td>
      </tr>`).join("")}
    </tbody>
  </table>`}

  <div class="footer">
    Designated record set per HIPAA §164.501. This export is a snapshot
    of records held in Pallio at the time of generation. Each bill carries the
    ID of the visit it bills. Questions or amendments: contact your provider.
  </div>
</body></html>`;
}
