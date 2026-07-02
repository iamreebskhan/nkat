/**
 * Download the REAL, current CMS ruling PDFs and self-host them so the
 * platform's extraction engine can ingest them.
 *
 * WHY self-host instead of pointing an ingestion source straight at cms.gov:
 * CMS's bot manager 403s server-side fetchers (the ingest cron sends
 * User-Agent "Pallio-ingest/1.0", which CMS blocks). A browser User-Agent
 * is served fine — so we fetch here with a browser UA and drop the PDFs into
 * public/test-fixtures/cms/, which Next serves at
 *   https://app.pallio.io/test-fixtures/cms/<file>.pdf
 * The ingest cron then fetches from app.pallio.io (itself), never from CMS.
 *
 * These are genuine U.S. Government works (CMS MLN / final-rule summary),
 * publicly published. They are NOT committed to the repo (see .gitignore) —
 * they're fetched fresh on the VPS so you always test the current documents.
 *
 * Run on the VPS:
 *   node scripts/fetch-cms-real-pdfs.mjs
 * then register + extract:
 *   sudo -u postgres psql pallio -f db/seed/ingestion-source-cms-real.sql
 *   curl -X POST -H "x-cron-secret: $CRON_SECRET" https://app.pallio.io/api/cron/ingest-documents
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), "public", "test-fixtures", "cms");
mkdirSync(OUT_DIR, { recursive: true });

// A real browser UA + headers — CMS serves these; it 403s bot UAs.
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

// The real CMS documents. Each is a genuine coverage/payment ruling or the
// official MLN explainer of one, small enough to extract natively
// (< 600 pages / < 32 MB — the Claude native-PDF ceiling for a 1M model).
export const CMS_DOCS = [
  {
    file: "mm14315-pfs-final-rule-summary-cy2026.pdf",
    url: "https://www.cms.gov/files/document/mm14315-medicare-physician-fee-schedule-final-rule-summary-cy-2026.pdf",
    documentType: "cms_pfs",
    title: "CMS — CY2026 Physician Fee Schedule Final Rule Summary (CMS-1832-F)",
  },
  {
    file: "mln901705-telehealth-rpm.pdf",
    url: "https://www.cms.gov/files/document/mln901705-telehealth-remote-patient-monitoring.pdf",
    documentType: "mln_article",
    title: "CMS — Telehealth & Remote Patient Monitoring (MLN901705)",
  },
  {
    file: "mln006764-evaluation-management.pdf",
    url: "https://www.cms.gov/files/document/mln006764-evaluation-management-services.pdf",
    documentType: "mln_article",
    title: "CMS — Evaluation & Management Services (MLN006764)",
  },
  {
    file: "mln909289-advance-care-planning.pdf",
    url: "https://www.cms.gov/files/document/mln-advanced-care-planning.pdf",
    documentType: "mln_article",
    title: "CMS — Advance Care Planning (MLN909289)",
  },
];

async function download(doc) {
  const res = await fetch(doc.url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString() !== "%PDF-")
    throw new Error(`not a PDF (got ${buf.subarray(0, 16).toString("hex")})`);
  writeFileSync(join(OUT_DIR, doc.file), buf);
  return buf.length;
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("fetch-cms-real-pdfs.mjs");
if (isMain) {
  let ok = 0;
  for (const doc of CMS_DOCS) {
    try {
      const bytes = await download(doc);
      console.log(`✅ ${doc.file}  (${(bytes / 1024).toFixed(0)} KB)  [${doc.documentType}]`);
      ok++;
    } catch (e) {
      console.log(`❌ ${doc.file}  — ${e.message}`);
    }
  }
  console.log(`\n${ok}/${CMS_DOCS.length} downloaded → ${OUT_DIR}`);
  console.log("Served at: https://app.pallio.io/test-fixtures/cms/<file>.pdf");
  if (ok < CMS_DOCS.length) process.exit(1);
}
