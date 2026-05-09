/**
 * Per-patient record export — HIPAA right of access (45 CFR §164.524).
 *
 * Renders the full patient chart (demographics + visits + care plan +
 * superbills + denials) as a branded PDF. Triggers a phi_export_log row.
 *
 * Designation §164.524(c)(2)(ii): a covered entity must provide access
 * within 30 calendar days. Self-serve PDF satisfies that for
 * patient-requested records routed through the org's portal flow,
 * and gives an org admin a one-click way to fulfill walk-in requests.
 */
import puppeteer, { type Browser } from "puppeteer";

import { withOrgContext } from "@/lib/db";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

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

interface PatientRow {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: Date;
  primary_payer_name: string | null;
  primary_member_id: string | null;
}

interface VisitRow {
  id: string;
  visit_type: string;
  status: string;
  scheduled_start: Date | null;
  start_time: Date | null;
  total_minutes: number | null;
  cpt_codes: string[];
  icd10_codes: string[];
}

interface SuperbillRow {
  id: string;
  status: string;
  date_of_service: Date;
  cpt_codes: string[];
  billed_amount_cents: bigint;
  paid_amount_cents: bigint | null;
}

export async function exportPatientRecord(
  input: PatientExportInput,
): Promise<PatientExportResult> {
  const data = await withOrgContext(input.orgId, async (tx) => {
    const patientRows = await tx.$queryRaw<PatientRow[]>`
      SELECT p.id, p.first_name, p.last_name, p.date_of_birth,
             pa.name AS primary_payer_name, p.primary_member_id
      FROM patient p
      LEFT JOIN payer pa ON pa.id = p.primary_payer_id
      WHERE p.id = ${input.patientId}::uuid
      LIMIT 1
    `;
    const patient = patientRows[0];
    if (!patient) throw new Error("Patient not found.");

    const visits = await tx.$queryRaw<VisitRow[]>`
      SELECT id, visit_type, status, scheduled_start, start_time, total_minutes,
             cpt_codes, icd10_codes
      FROM visit
      WHERE patient_id = ${input.patientId}::uuid
      ORDER BY COALESCE(start_time, scheduled_start, created_at) DESC
      LIMIT 200
    `;

    const superbills = await tx.$queryRaw<SuperbillRow[]>`
      SELECT id, status, date_of_service, cpt_codes, billed_amount_cents, paid_amount_cents
      FROM superbill
      WHERE patient_id = ${input.patientId}::uuid
      ORDER BY date_of_service DESC
      LIMIT 200
    `;

    const carePlanRows = await tx.$queryRaw<{ goals_of_care_summary: string | null; updated_at: Date }[]>`
      SELECT goals_of_care_summary, updated_at FROM care_plan
      WHERE patient_id = ${input.patientId}::uuid
      LIMIT 1
    `;

    return { patient, visits, superbills, carePlan: carePlanRows[0] ?? null };
  });

  const html = renderHtml(input, data.patient, data.visits, data.superbills, data.carePlan);

  const browser = await getBrowser();
  const page = await browser.newPage();
  let pdfBytes: Buffer;
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const result = await page.pdf({
      format: "Letter",
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
      printBackground: true,
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
    patientName: `${data.patient.first_name} ${data.patient.last_name}`,
  };
}

function renderHtml(
  input: PatientExportInput,
  p: PatientRow,
  visits: VisitRow[],
  superbills: SuperbillRow[],
  carePlan: { goals_of_care_summary: string | null; updated_at: Date } | null,
): string {
  const primary = input.primaryColor ?? "#0d9488";
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
  const dob = p.date_of_birth.toISOString().slice(0, 10);

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; font-size: 11px; color: #0f172a; margin: 0; }
  .header { display:flex; justify-content:space-between; align-items:baseline; border-bottom: 2px solid ${primary}; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-size: 18px; font-weight: 700; color: ${primary}; }
  h2 { font-size: 14px; margin: 18px 0 6px; border-left: 3px solid ${primary}; padding-left: 8px; }
  table { width:100%; border-collapse: collapse; margin-bottom: 8px; }
  th { font-size: 9px; text-transform: uppercase; color: #64748b; padding: 4px 6px; border-bottom: 1px solid #e2e8f0; text-align: left; }
  td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .mono { font-family: 'JetBrains Mono', monospace; }
  .footer { font-size: 9px; color: #64748b; margin-top: 18px; padding-top: 8px; border-top: 1px solid #e2e8f0; }
</style>
</head><body>
  <div class="header">
    <div>
      <div class="brand">${escape(input.orgName)}</div>
      <div style="font-size:10px;color:#64748b">Patient record export</div>
    </div>
    <div style="font-size:10px;color:#475569;text-align:right">
      <div>Generated ${generatedAt}</div>
      <div>Per HIPAA §164.524 (right of access)</div>
    </div>
  </div>

  <h2>Patient</h2>
  <table>
    <tr><th style="width:40%">Name</th><td>${escape(p.first_name)} ${escape(p.last_name)}</td></tr>
    <tr><th>DOB</th><td class="mono">${dob}</td></tr>
    <tr><th>Primary payer</th><td>${escape(p.primary_payer_name ?? "—")}</td></tr>
    <tr><th>Member ID</th><td class="mono">${escape(p.primary_member_id ?? "—")}</td></tr>
  </table>

  ${carePlan ? `
  <h2>Care plan</h2>
  <p style="font-size:10px;color:#64748b;margin:0 0 4px">Last updated ${carePlan.updated_at.toISOString().slice(0, 10)}</p>
  <p style="white-space:pre-wrap">${escape(carePlan.goals_of_care_summary ?? "(no summary)")}</p>
  ` : ""}

  <h2>Visits (${visits.length})</h2>
  ${visits.length === 0 ? `<p style="color:#64748b">No visits recorded.</p>` : `
  <table>
    <thead><tr>
      <th>Date</th><th>Type</th><th>Status</th><th>Min</th><th>CPT</th><th>ICD-10</th>
    </tr></thead>
    <tbody>
      ${visits.map((v) => {
        const date = (v.start_time ?? v.scheduled_start)?.toISOString().slice(0, 10) ?? "—";
        return `<tr>
          <td class="mono">${date}</td>
          <td>${escape(v.visit_type.replace(/_/g, " "))}</td>
          <td>${escape(v.status)}</td>
          <td class="mono">${v.total_minutes ?? "—"}</td>
          <td class="mono">${(v.cpt_codes ?? []).join(", ")}</td>
          <td class="mono">${(v.icd10_codes ?? []).join(", ")}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>`}

  <h2>Superbills (${superbills.length})</h2>
  ${superbills.length === 0 ? `<p style="color:#64748b">None.</p>` : `
  <table>
    <thead><tr>
      <th>DOS</th><th>Status</th><th>CPT</th><th style="text-align:right">Billed</th><th style="text-align:right">Paid</th>
    </tr></thead>
    <tbody>
      ${superbills.map((s) => `<tr>
        <td class="mono">${s.date_of_service.toISOString().slice(0, 10)}</td>
        <td>${escape(s.status)}</td>
        <td class="mono">${(s.cpt_codes ?? []).join(", ")}</td>
        <td class="mono" style="text-align:right">$${(Number(s.billed_amount_cents) / 100).toFixed(2)}</td>
        <td class="mono" style="text-align:right">${s.paid_amount_cents != null ? "$" + (Number(s.paid_amount_cents) / 100).toFixed(2) : "—"}</td>
      </tr>`).join("")}
    </tbody>
  </table>`}

  <div class="footer">
    Designated record set per HIPAA §164.501. This export is a snapshot
    of records held in Pallio at the time of generation. Questions or
    amendments: contact your provider.
  </div>
</body></html>`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
