/**
 * Superbill PDF generator — Puppeteer, branded with org_branding.
 *
 * Output mirrors the CMS-1500 paper-claim layout closely enough that
 * billing staff recognize it. Logs to phi_export_log for the HIPAA
 * accounting-of-disclosures audit.
 */
import puppeteer, { type Browser } from "puppeteer";

import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { formatCodes, type CodeUnits } from "@/lib/features/billing/code-units";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import { submissionStamp } from "./superbill-pure";

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

interface SuperbillData {
  id: string;
  /** The visit this bills — the same key the patient record export prints (R28). */
  visit_id: string;
  status: string;
  date_of_service: Date;
  cpt_codes: string[];
  /** Units per code when more than one (0106); {} = one each. */
  cpt_units: CodeUnits | null;
  icd10_codes: string[];
  modifiers: string[] | null;
  member_id_snapshot: string;
  provider_npi: string;
  provider_name: string;
  billing_npi: string | null;
  place_of_service_code: string;
  pos_description: string | null;
  billed_amount_cents: bigint;
  paid_amount_cents: bigint | null;
  payer_name: string | null;
  patient_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: Date;
}

interface Branding {
  display_name: string | null;
  primary_color: string | null;
}

export async function generateSuperbillPdf(args: {
  orgId: string;
  userId: string;
  superbillId: string;
}): Promise<{ pdfBytes: Buffer; superbill: SuperbillData }> {
  const { orgId, userId, superbillId } = args;

  const fetched = await withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<SuperbillData[]>`
      SELECT s.id, s.visit_id, s.status, s.date_of_service,
             s.cpt_codes, s.cpt_units, s.icd10_codes, s.modifiers,
             s.member_id_snapshot, s.provider_npi, s.provider_name, s.billing_npi,
             s.place_of_service_code, pos.description AS pos_description,
             s.billed_amount_cents, s.paid_amount_cents,
             p.name AS payer_name,
             s.patient_id, pt.first_name, pt.last_name, pt.date_of_birth
      FROM superbill s
      LEFT JOIN payer p ON p.id = s.payer_id
      JOIN patient pt ON pt.id = s.patient_id
      LEFT JOIN pos ON pos.pos = s.place_of_service_code
      WHERE s.id = ${superbillId}::uuid
      LIMIT 1
    `;
    if (rows.length === 0) throw new NotFoundError("Superbill not found.");

    const orgRow = await tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM org WHERE id = ${orgId}::uuid LIMIT 1
    `;
    const brandRow = await tx.$queryRaw<Branding[]>`
      SELECT display_name, primary_color FROM org_branding
       WHERE org_id = ${orgId}::uuid LIMIT 1
    `;
    return {
      sb: rows[0]!,
      orgName: brandRow[0]?.display_name ?? orgRow[0]?.name ?? "Pallio Organization",
      primary: brandRow[0]?.primary_color ?? "#0d9488",
    };
  });

  const html = renderHtml(fetched);

  const browser = await getBrowser();
  const page = await browser.newPage();
  let pdfBytes: Buffer;
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10_000 });
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
    orgId,
    userId,
    exportType: "superbill_pdf",
    patientIds: [fetched.sb.patient_id],
    byteSize: pdfBytes.byteLength,
  });

  return { pdfBytes, superbill: fetched.sb };
}

/**
 * The printed bill. Its status line says "as recorded in Pallio" (audit R35):
 * the PDF travels in the audit packet, where a bare "Status: paid" reads as the
 * payer's word rather than the org's own record.
 */
function renderHtml(d: { sb: SuperbillData; orgName: string; primary: string }): string {
  const { sb, orgName, primary } = d;
  const dob = sb.date_of_birth.toISOString().slice(0, 10);
  const dos = sb.date_of_service.toISOString().slice(0, 10);
  const billed = (Number(sb.billed_amount_cents) / 100).toFixed(2);
  const paid = sb.paid_amount_cents == null ? "—" : (Number(sb.paid_amount_cents) / 100).toFixed(2);

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Superbill ${sb.id.slice(0, 8)}</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; color: #0f172a; margin: 0; font-size: 12px; }
  .hd { display: flex; justify-content: space-between; border-bottom: 3px solid ${primary}; padding-bottom: 10px; margin-bottom: 16px; }
  h1 { font-size: 18px; font-weight: 700; margin: 0; color: ${primary}; }
  .meta { font-size: 10px; text-align: right; color: #475569; line-height: 1.5; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; margin: 18px 0 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  td { padding: 4px 6px; vertical-align: top; font-size: 11px; }
  .k { color: #64748b; width: 30%; }
  .mono { font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  .totals { font-size: 13px; font-weight: 700; }
  .footer { margin-top: 24px; font-size: 9px; color: #64748b; text-align: center; }
  .stamp { display: inline-block; margin-bottom: 4px; padding: 2px 6px; border: 1px solid #b91c1c; color: #b91c1c; font-weight: 700; }
</style></head><body>
  <div class="hd">
    <div>
      <h1>${esc(orgName)}</h1>
      <div style="font-size: 11px; color: #64748b;">Superbill / Encounter Form</div>
    </div>
    <div class="meta">
      <div>Superbill <span class="mono">${esc(sb.id)}</span></div>
      <div>Patient account no. (box 26): <span class="mono">${esc(claimRefFor(sb.id))}</span></div>
      <div>Visit <span class="mono">${esc(sb.visit_id)}</span></div>
      ${submissionStamp(sb.status) ? `<div class="stamp">${esc(submissionStamp(sb.status) ?? "")}</div>` : ""}
      <div>Status (as recorded in Pallio): <strong>${esc(sb.status)}</strong></div>
      <div>DOS: <strong>${dos}</strong></div>
    </div>
  </div>

  <h2>Patient</h2>
  <table>
    <tr><td class="k">Name</td><td>${esc(sb.first_name)} ${esc(sb.last_name)}</td></tr>
    <tr><td class="k">Date of birth</td><td class="mono">${dob}</td></tr>
    <tr><td class="k">Member ID</td><td class="mono">${esc(sb.member_id_snapshot)}</td></tr>
    <tr><td class="k">Payer</td><td>${esc(sb.payer_name ?? "—")}</td></tr>
  </table>

  <h2>Provider</h2>
  <table>
    <tr><td class="k">Rendering provider</td><td>${esc(sb.provider_name)}</td></tr>
    <tr><td class="k">Rendering NPI (box 24J)</td><td class="mono">${esc(sb.provider_npi || "not recorded")}</td></tr>
    <tr><td class="k">Billing provider NPI (box 33a)</td><td class="mono">${esc(sb.billing_npi || "not recorded")}</td></tr>
  </table>

  <h2>Codes</h2>
  <table>
    <tr><td class="k">CPT / HCPCS</td><td class="mono">${esc(formatCodes(sb.cpt_codes ?? [], sb.cpt_units) || "—")}</td></tr>
    <tr><td class="k">ICD-10</td><td class="mono">${esc((sb.icd10_codes ?? []).join(", ") || "—")}</td></tr>
    <tr><td class="k">Modifiers</td><td class="mono">${esc((sb.modifiers ?? []).join(", ") || "—")}</td></tr>
    <tr><td class="k">Place of service</td><td>${esc(sb.place_of_service_code)}${sb.pos_description ? ` — ${esc(sb.pos_description)}` : ""}</td></tr>
  </table>

  <h2>Charges</h2>
  <table>
    <tr><td class="k">Billed</td><td class="totals">$${billed}</td></tr>
    <tr><td class="k">Paid</td><td class="totals">${paid === "—" ? "—" : `$${paid}`}</td></tr>
  </table>

  <p class="footer">
    Generated by Pallio for ${esc(orgName)} · This document contains PHI under HIPAA.
    Disclosure is logged in <span class="mono">phi_export_log</span>.
  </p>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
