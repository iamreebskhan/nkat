/**
 * Generate a realistic Medicare "final rule" policy PDF for testing the
 * platform's document EXTRACTION + COMPARISON on varied scenarios.
 *
 * Renders to public/test-fixtures/medicare-final-rule-2026.pdf so it's
 * served at  <BASE>/test-fixtures/medicare-final-rule-2026.pdf  and can be
 * registered as an ingestion source (Medicare / OH). The ingest cron then
 * fetches it, hands the native PDF to Claude, and extracts payer_rule rows.
 *
 * The scenarios are deliberately DIVERSE so extraction is genuinely
 * exercised: covered, not-covered, prior-auth, telehealth parity,
 * frequency limit, documentation requirement, and add-on compatibility.
 *
 * Run on the VPS (puppeteer + Chromium already used for cheat-sheets):
 *   node scripts/gen-medicare-test-pdf.mjs
 */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), "public", "test-fixtures");
mkdirSync(OUT_DIR, { recursive: true });
const OUT = join(OUT_DIR, "medicare-final-rule-2026.pdf");

// Each row is a distinct extraction scenario. `verbatim` is a clear
// sentence the model can quote; `expect` documents what the extractor
// SHOULD produce (used by verify-medicare-extraction.mjs).
const SCENARIOS = [
  { code: "99347", desc: "Home visit, established patient, 15 minutes", verbatim: "CPT 99347 (home visit, established patient, typically 15 minutes) is COVERED for Medicare beneficiaries in Ohio when medically necessary.", expect: "covered" },
  { code: "99348", desc: "Home visit, established patient, 25 minutes", verbatim: "CPT 99348 (home visit, established patient, typically 25 minutes) is COVERED.", expect: "covered" },
  { code: "99349", desc: "Home visit, established patient, 40 minutes", verbatim: "CPT 99349 (home visit, established patient, typically 40 minutes) is COVERED when the medical record documents medical necessity.", expect: "covered" },
  { code: "99350", desc: "Home visit, established patient, 60 minutes", verbatim: "CPT 99350 (home visit, established patient, typically 60 minutes) is COVERED.", expect: "covered" },
  { code: "99497", desc: "Advance care planning, first 30 minutes", verbatim: "CPT 99497 (advance care planning, first 30 minutes) is COVERED; the record must document that the discussion was voluntary and note the beneficiary or surrogate present.", expect: "covered (documentation required)" },
  { code: "99498", desc: "Advance care planning, each additional 30 minutes", verbatim: "CPT 99498 (advance care planning, each additional 30 minutes) is COVERED only as an add-on reported with 99497.", expect: "covered (add-on with 99497)" },
  { code: "99453", desc: "Remote physiologic monitoring set-up & education", verbatim: "CPT 99453 (remote physiologic monitoring set-up and patient education) is NOT COVERED under the home-health consolidated billing benefit for these beneficiaries.", expect: "not_covered" },
  { code: "99454", desc: "RPM device supply, 30 days", verbatim: "CPT 99454 (RPM device supply with daily recordings, each 30 days) is COVERED but is limited to one unit per 30-day period and requires at least 16 days of transmitted data.", expect: "covered (frequency limit: 1 per 30 days, 16 days data)" },
  { code: "99457", desc: "RPM treatment management, first 20 minutes", verbatim: "CPT 99457 (remote physiologic monitoring treatment management services, first 20 minutes) is COVERED but REQUIRES PRIOR AUTHORIZATION.", expect: "covered (prior authorization required)" },
  { code: "98016", desc: "Brief virtual check-in", verbatim: "HCPCS 98016 (brief communication technology-based service / virtual check-in) is reimbursed via telehealth at payment parity when billed with modifier 95.", expect: "covered / telehealth (modifier 95)" },
  { code: "99251", desc: "Inpatient consultation, straightforward", verbatim: "CPT 99251 (inpatient consultation) is NOT COVERED; Medicare does not recognize consultation codes and payment will be denied.", expect: "not_covered" },
  { code: "G0179", desc: "Home health recertification", verbatim: "HCPCS G0179 (physician recertification for Medicare-covered home health services) is COVERED once per 60-day episode.", expect: "covered (1 per 60-day episode)" },
];

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { margin: 0.9in 0.85in; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 11.5px; line-height: 1.5; }
  .fed { text-align:center; letter-spacing:1px; color:#444; font-size:10px; }
  h1 { font-size: 18px; text-align:center; margin: 6px 0 2px; }
  h2 { font-size: 13px; border-bottom: 1px solid #999; padding-bottom: 3px; margin-top: 20px; }
  .meta { text-align:center; color:#555; font-size:10px; margin-bottom: 14px; }
  .lead { font-style: italic; color:#333; }
  ol { padding-left: 20px; } li { margin: 7px 0; }
  .code { font-family: 'Courier New', monospace; font-weight: bold; }
  table { width:100%; border-collapse: collapse; margin-top: 10px; font-size: 10.5px; }
  th,td { border: 1px solid #bbb; padding: 5px 7px; text-align:left; vertical-align: top; }
  th { background:#eee; }
  .foot { margin-top: 22px; font-size: 9px; color:#666; border-top: 1px solid #ccc; padding-top: 6px; }
</style></head><body>
  <div class="fed">DEPARTMENT OF HEALTH AND HUMAN SERVICES · CENTERS FOR MEDICARE &amp; MEDICAID SERVICES</div>
  <h1>Medicare Program; Final Rule — Home-Based &amp; Palliative Services Coverage (CY 2026)</h1>
  <div class="meta">42 CFR Part 410 · CMS-1234-F · Effective January 1, 2026 · Jurisdiction: Ohio (MAC JL/JM reference)</div>

  <p class="lead">This final rule sets out coverage and payment determinations for home-based
  evaluation and management, advance care planning, remote physiologic monitoring, and
  telehealth services furnished to Medicare beneficiaries. Contractors shall apply the
  determinations below. (This is a synthetic document generated for platform testing.)</p>

  <h2>I. Coverage Determinations by Code</h2>
  <ol>
    ${SCENARIOS.map((s) => `<li><span class="code">${esc(s.code)}</span> — ${esc(s.desc)}.<br/>${esc(s.verbatim)}</li>`).join("\n    ")}
  </ol>

  <h2>II. Summary Table</h2>
  <table>
    <thead><tr><th>Code</th><th>Description</th><th>Determination</th></tr></thead>
    <tbody>
      ${SCENARIOS.map((s) => `<tr><td class="code">${esc(s.code)}</td><td>${esc(s.desc)}</td><td>${esc(s.expect)}</td></tr>`).join("\n      ")}
    </tbody>
  </table>

  <h2>III. Documentation &amp; Billing Notes</h2>
  <p>Advance care planning (99497/99498) requires documentation that the discussion was
  voluntary. Remote physiologic monitoring management (99457) requires prior authorization
  before the first management service is billed. Telehealth-eligible services must append
  modifier 95 for synchronous audio-video encounters. Consultation codes (99251–99255) are
  not payable under Medicare.</p>

  <div class="foot">Synthetic test fixture — not an official CMS publication. Generated for
  Pallio extraction/comparison verification. CPT is a registered trademark of the AMA.</div>
</body></html>`;

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10_000 });
  await page.pdf({
    path: OUT,
    format: "Letter",
    margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
    printBackground: true,
  });
  await browser.close();
  console.log(`✅ Wrote ${OUT}`);
  console.log(`   ${SCENARIOS.length} scenarios embedded.`);
  console.log(`   Served at: <BASE>/test-fixtures/medicare-final-rule-2026.pdf`);
})().catch((e) => { console.error(e); process.exit(1); });
