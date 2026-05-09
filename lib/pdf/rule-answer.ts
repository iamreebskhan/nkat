/**
 * Rule answer PDF generator.
 *
 * Source: pallio_complete_vision_v3 §5.1 (Export to PDF), §15.1
 * (legal disclaimer).
 *
 * Renders a single-page branded PDF of a rule lookup result. Used by
 * the billing agent's "Export to PDF" button so they can keep a
 * cited record alongside the claim submission.
 *
 * Implementation: Puppeteer + a hand-built HTML template. Why not
 * @react-pdf/renderer? Puppeteer + HTML stays consistent with the
 * superbill + cheat-sheet generators we'll add in Phases 3 & 6 — one
 * rendering path, less code surface to maintain.
 */
import puppeteer, { type Browser } from "puppeteer";

import { env } from "@/lib/env";

export interface RuleAnswerPdfInput {
  question: string;
  answer: string;
  coverageStatus: "covered" | "not_covered" | "varies" | "unknown";
  confidence: number;
  source: "structured_rule" | "ai_synthesized" | "unknown";
  citation: {
    documentName: string;
    documentUrl?: string | null;
    effectiveDate?: string | null;
    verbatimQuote: string;
    page?: number | null;
  } | null;
  meta: {
    payer?: string;
    state?: string;
    cptCode?: string;
    queriedAt: Date;
    /** Caller-supplied org name, used in the header band. */
    orgName?: string;
  };
}

const STATUS_LABELS: Record<RuleAnswerPdfInput["coverageStatus"], string> = {
  covered: "COVERED",
  not_covered: "NOT COVERED",
  varies: "VARIES BY PLAN",
  unknown: "UNKNOWN",
};

const STATUS_COLORS: Record<RuleAnswerPdfInput["coverageStatus"], string> = {
  covered: "#065f46",
  not_covered: "#991b1b",
  varies: "#92400e",
  unknown: "#475569",
};

const STATUS_BG: Record<RuleAnswerPdfInput["coverageStatus"], string> = {
  covered: "#ecfdf5",
  not_covered: "#fef2f2",
  varies: "#fffbeb",
  unknown: "#f1f5f9",
};

const DISCLAIMER =
  "Rules are provided for reference and should be verified with the payer before claim submission. " +
  "Pallio and NTAKT Inc. are not liable for claim outcomes based on this information.";

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

/**
 * Render a single-page rule answer PDF. Returns the bytes; the caller
 * is responsible for streaming/storing.
 */
export async function renderRuleAnswerPdf(
  input: RuleAnswerPdfInput,
): Promise<Buffer> {
  const html = renderHtml(input);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "Letter",
      margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
      printBackground: true,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

function renderHtml(input: RuleAnswerPdfInput): string {
  const { question, answer, coverageStatus, confidence, citation, meta } = input;
  const status = STATUS_LABELS[coverageStatus];
  const statusColor = STATUS_COLORS[coverageStatus];
  const statusBg = STATUS_BG[coverageStatus];
  const queriedAt = meta.queriedAt.toISOString().replace("T", " ").slice(0, 19) + "Z";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Pallio Rule Lookup — ${escapeHtml(meta.cptCode ?? "")}</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; color: #0f172a; margin: 0; }
  .header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #0d9488; padding-bottom: 12px; margin-bottom: 18px; }
  .brand { font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; font-size: 22px; letter-spacing: -0.01em; color: #0f766e; }
  .meta { font-size: 11px; color: #475569; text-align: right; line-height: 1.4; }
  .meta strong { color: #0f172a; }
  h1 { font-size: 16px; margin: 0 0 6px 0; font-weight: 600; }
  .question { font-size: 14px; color: #334155; margin-bottom: 18px; }
  .status { display: inline-block; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 12px; letter-spacing: 0.04em; }
  .row { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; }
  .confidence { font-size: 11px; color: #475569; font-variant-numeric: tabular-nums; }
  .answer { font-size: 13px; line-height: 1.55; margin-bottom: 18px; white-space: pre-wrap; }
  .citation { border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; background: #f8fafc; }
  .citation .label { font-size: 11px; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; font-weight: 600; }
  .citation .doc { font-size: 12px; color: #0f172a; margin-bottom: 8px; }
  .citation .quote { border-left: 4px solid #94a3b8; background: white; padding: 10px 12px; font-style: italic; color: #1e293b; font-size: 12px; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #64748b; line-height: 1.5; }
  .source-tag { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 10px; background: #f1f5f9; color: #334155; margin-left: 8px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">Pallio</div>
      <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Billing rule lookup</div>
    </div>
    <div class="meta">
      ${meta.orgName ? `<div><strong>${escapeHtml(meta.orgName)}</strong></div>` : ""}
      <div>Queried ${queriedAt}</div>
      ${meta.payer ? `<div>Payer: ${escapeHtml(meta.payer)}</div>` : ""}
      ${meta.state ? `<div>State: ${escapeHtml(meta.state)}</div>` : ""}
      ${meta.cptCode ? `<div>Code: <strong>${escapeHtml(meta.cptCode)}</strong></div>` : ""}
    </div>
  </div>

  <h1>Question</h1>
  <p class="question">${escapeHtml(question)}</p>

  <div class="row">
    <span class="status" style="background: ${statusBg}; color: ${statusColor};">${status}</span>
    <span class="source-tag">${input.source.replace("_", " ")}</span>
    ${confidence > 0 ? `<span class="confidence">confidence ${(confidence * 100).toFixed(0)}%</span>` : ""}
  </div>

  <div class="answer">${escapeHtml(answer)}</div>

  ${
    citation
      ? `
  <div class="citation">
    <div class="label">Source citation</div>
    <div class="doc">
      <strong>${escapeHtml(citation.documentName)}</strong>
      ${citation.effectiveDate ? `<span style="color: #64748b;"> (effective ${escapeHtml(citation.effectiveDate)})</span>` : ""}
      ${citation.page ? `<span style="color: #64748b;"> — page ${citation.page}</span>` : ""}
      ${citation.documentUrl ? `<div style="font-size: 10px; word-break: break-all; margin-top: 4px;">${escapeHtml(citation.documentUrl)}</div>` : ""}
    </div>
    <div class="quote">&ldquo;${escapeHtml(citation.verbatimQuote)}&rdquo;</div>
  </div>
  `
      : `
  <div class="citation">
    <div class="label">No source available</div>
    <div class="doc">
      This response is the platform's standard "unknown rule" message. No
      payer policy document or analyst attestation matched the request.
    </div>
  </div>
  `
  }

  <div class="footer">
    <strong>Disclaimer.</strong> ${DISCLAIMER}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Suppress unused warning for env(); Puppeteer config will branch on
// env in a follow-up phase (e.g. Hostinger uses an executable path,
// local dev downloads its own). Imported now to lock the dependency.
void env;
