/**
 * Cheat sheet service — query the org's rulebook + render a branded PDF.
 *
 * Source: pallio_complete_vision_v3 §6.7.
 *
 * Mark's primary deliverable for client engagements: branded PDF of
 * payer rules per state × payer × CPT subset. Output: list rows by
 * code with coverage status, prior auth, telehealth, billing limit,
 * add-on codes, documentation requirements.
 */
import puppeteer, { type Browser } from "puppeteer";

import { withOrgContext } from "@/lib/db";

export interface CheatSheetInput {
  orgId: string;
  generatedByUserId: string;
  /** Filters — null = all. */
  state: string | null;
  payerId: string | null;
  cptCodes: string[];
  /** Org branding to render in the header. */
  orgName: string;
  logoUrl?: string;
  primaryColor?: string;
}

export interface CheatSheetResult {
  id: string;
  pdfBytes: Buffer;
  pdfPath: string;
  rowCount: number;
}

interface RulebookRow {
  payer_id: string;
  payer_name: string;
  state: string;
  cpt_code: string;
  attribute: string;
  rule_value: Record<string, unknown>;
  coverage_status: string;
  source_quote: string | null;
}

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

export async function generateCheatSheet(
  input: CheatSheetInput,
): Promise<CheatSheetResult> {
  const rows = await fetchRows(input);
  const html = renderHtml(input, rows);

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

  // Persist a generation log entry. The actual PDF storage in dev is
  // a placeholder path — Phase 7 wires S3 / disk.
  const pseudoPath = `local://cheatsheets/${input.orgId}/${Date.now()}.pdf`;
  const id = await withOrgContext(input.orgId, async (tx) => {
    const ins = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO cheat_sheet_generation (
        org_id, state, payer_id, cpt_codes, pdf_path, pdf_byte_size,
        rendered_title, rendered_logo_url, generated_by_user_id
      ) VALUES (
        ${input.orgId}::uuid, ${input.state ?? null}, ${input.payerId ?? null}::uuid,
        ${input.cptCodes}::text[], ${pseudoPath}, ${pdfBytes.byteLength},
        ${`${input.orgName} — Pallio cheat sheet`},
        ${input.logoUrl ?? null}, ${input.generatedByUserId}::uuid
      )
      RETURNING id
    `;
    return ins[0]!.id;
  });

  return { id, pdfBytes, pdfPath: pseudoPath, rowCount: rows.length };
}

async function fetchRows(input: CheatSheetInput): Promise<RulebookRow[]> {
  return withOrgContext(input.orgId, async (tx) => {
    return tx.$queryRaw<RulebookRow[]>`
      SELECT
        rb_row.payer_id, p.name AS payer_name, rb_row.state, rb_row.cpt_code,
        rb_row.attribute, rb_row.rule_value, rb_row.coverage_status,
        rb_row.source_quote
      FROM org_rulebook_row rb_row
      JOIN org_rulebook rb ON rb.id = rb_row.rulebook_id
      LEFT JOIN payer p ON p.id = rb_row.payer_id
      WHERE rb_row.org_id = ${input.orgId}::uuid
        AND (${input.state ?? null}::text IS NULL OR rb_row.state = ${input.state ?? null})
        AND (${input.payerId ?? null}::uuid IS NULL OR rb_row.payer_id = ${input.payerId ?? null}::uuid)
        AND (${input.cptCodes.length === 0} OR rb_row.cpt_code = ANY(${input.cptCodes}::text[]))
      ORDER BY rb_row.state, p.name, rb_row.cpt_code, rb_row.attribute
    `;
  });
}

const STATUS_COLORS: Record<string, string> = {
  covered: "#065f46",
  not_covered: "#991b1b",
  varies: "#92400e",
  unknown: "#475569",
};
const STATUS_BG: Record<string, string> = {
  covered: "#ecfdf5",
  not_covered: "#fef2f2",
  varies: "#fffbeb",
  unknown: "#f1f5f9",
};

function renderHtml(input: CheatSheetInput, rows: RulebookRow[]): string {
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
  const primary = input.primaryColor ?? "#0d9488";
  const grouped = groupBy(rows, (r) => `${r.state}|${r.payer_name ?? "—"}`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(input.orgName)} — Pallio cheat sheet</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; color: #0f172a; margin: 0; font-size: 11px; }
  .header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid ${primary}; padding-bottom: 10px; margin-bottom: 14px; }
  .brand { font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; font-size: 18px; color: ${primary}; }
  .meta { font-size: 10px; color: #475569; text-align: right; line-height: 1.4; }
  h2 { font-size: 13px; margin: 14px 0 6px; color: #0f172a; border-left: 3px solid ${primary}; padding-left: 8px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  th { text-align: left; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; padding: 4px 6px; border-bottom: 1px solid #e2e8f0; }
  td { padding: 5px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .cpt { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 11px; }
  .status { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 9px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; }
  .quote { font-style: italic; color: #475569; font-size: 9px; }
  .footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 9px; color: #64748b; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">${escapeHtml(input.orgName)}</div>
      <div style="font-size: 10px; color: #64748b;">Billing rule cheat sheet</div>
    </div>
    <div class="meta">
      <div>Generated ${generatedAt}</div>
      ${input.state ? `<div>State: <strong>${escapeHtml(input.state)}</strong></div>` : "<div>State: All</div>"}
      <div>Codes: <strong>${input.cptCodes.length || rows.length}</strong></div>
    </div>
  </div>

  ${
    rows.length === 0
      ? `<p style="text-align: center; color: #64748b; padding: 40px;">
           No rules in the org rulebook match this filter.
         </p>`
      : Array.from(grouped.entries())
          .map(([groupKey, items]) => {
            const [state, payer] = groupKey.split("|");
            return `
              <h2>${escapeHtml(state)} · ${escapeHtml(payer)}</h2>
              <table>
                <thead>
                  <tr>
                    <th style="width: 60px;">CPT</th>
                    <th style="width: 100px;">Attribute</th>
                    <th style="width: 80px;">Coverage</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  ${items
                    .map((r) => {
                      const detail = r.source_quote
                        ? `<div class="quote">&ldquo;${escapeHtml(r.source_quote)}&rdquo;</div>`
                        : valueDetail(r.rule_value);
                      return `
                        <tr>
                          <td class="cpt">${escapeHtml(r.cpt_code)}</td>
                          <td>${escapeHtml(r.attribute.replace(/_/g, " "))}</td>
                          <td><span class="status" style="color: ${STATUS_COLORS[r.coverage_status] ?? "#475569"}; background: ${STATUS_BG[r.coverage_status] ?? "#f1f5f9"};">${escapeHtml(r.coverage_status.replace("_", " "))}</span></td>
                          <td>${detail}</td>
                        </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>`;
          })
          .join("")
  }

  <div class="footer">
    <strong>Disclaimer.</strong> Rules are provided for reference and should be verified
    with the payer before claim submission. ${escapeHtml(input.orgName)}
    and Pallio are not liable for claim outcomes based on this information.
  </div>
</body>
</html>`;
}

function valueDetail(v: Record<string, unknown>): string {
  const txt = typeof v.answer === "string" ? v.answer : null;
  if (!txt) return "—";
  return `<div>${escapeHtml(txt)}</div>`;
}

function groupBy<T>(rows: T[], keyer: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyer(r);
    const a = m.get(k) ?? [];
    a.push(r);
    m.set(k, a);
  }
  return m;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
