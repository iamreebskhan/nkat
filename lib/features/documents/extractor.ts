/**
 * Document extractor — pure, dependency-free.
 *
 * Two ingestion shapes (gap A):
 *   1. Structured rulebook CSV  → parseRulebookCsv() → rule rows for
 *      Path B reconciliation (feeds rulebook_upload.parsed_rows).
 *   2. Free-text policy doc     → chunkText() → fixed-size chunks for
 *      embedding into document_chunk (powers the vector/RAG fallback).
 *
 * CSV is the pragmatic structured format: a cheat-sheet / rulebook
 * exported from Excel/Sheets. Zero deps, deterministic, unit-testable.
 * XLSX/PDF table extraction is intentionally out of scope here —
 * unreliable without heavy deps; CSV export is a one-click step for
 * the customer and far more accurate.
 */

import {
  COVERAGE_STATUSES,
  RULEBOOK_ATTRIBUTES,
  type CoverageStatus,
  type RulebookAttribute,
} from "@/lib/features/rulebook/rulebook.types";

export interface ParsedRulebookRow {
  /** Payer as written in the file (UUID or name) — endpoint resolves. */
  payerRef: string | null;
  state: string;
  cptCode: string;
  attribute: RulebookAttribute;
  coverageStatus: CoverageStatus;
  ruleValue: Record<string, unknown>;
}

export interface RulebookParseResult {
  rows: ParsedRulebookRow[];
  errors: string[];
}

/**
 * RFC4180-ish CSV tokenizer: handles quoted fields, embedded commas,
 * escaped double-quotes (""), and CRLF/LF line endings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// Strip everything but a-z0-9 so "Covered?", "CPT Code", "prior-auth"
// all normalize to comparable keys.
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

// Accepted header aliases → canonical key.
const HEADER_ALIASES: Record<string, string> = {
  payer: "payer", payerid: "payer", payername: "payer", plan: "payer",
  state: "state", st: "state",
  cpt: "cpt", cptcode: "cpt", code: "cpt", hcpcs: "cpt", procedure: "cpt",
  attribute: "attribute", attr: "attribute", rule: "attribute", ruletype: "attribute",
  coverage: "coverage", coveragestatus: "coverage", status: "coverage", covered: "coverage",
  value: "value", answer: "value", note: "value", notes: "value", detail: "value", details: "value",
};

const ATTR_SYNONYM: Record<string, RulebookAttribute> = {
  covered: "covered", coverage: "covered", iscovered: "covered",
  priorauth: "prior_auth", priorauthorization: "prior_auth", pa: "prior_auth", auth: "prior_auth",
  telehealth: "telehealth", telemedicine: "telehealth", virtual: "telehealth",
  providertype: "provider_type", taxonomy: "provider_type", provider: "provider_type",
  billinglimit: "billing_limit", limit: "billing_limit", unitslimit: "billing_limit",
  addoncompatible: "addon_compatible", addon: "addon_compatible", bundling: "addon_compatible",
  documentation: "documentation", docs: "documentation", documentationrequired: "documentation",
  frequencylimit: "frequency_limit", frequency: "frequency_limit",
  modifierrequired: "modifier_required", modifier: "modifier_required", modifiers: "modifier_required",
};

const COVERAGE_SYNONYM: Record<string, CoverageStatus> = {
  covered: "covered", yes: "covered", y: "covered", true: "covered", allowed: "covered",
  notcovered: "not_covered", no: "not_covered", n: "not_covered", false: "not_covered", denied: "not_covered", excluded: "not_covered",
  varies: "varies", conditional: "varies", sometimes: "varies", depends: "varies",
  unknown: "unknown", unverified: "unknown", "": "unknown",
};

/**
 * Parse a rulebook CSV into structured rows. The first non-empty row
 * is the header. Required logical columns: payer, state, cpt,
 * attribute. coverage + value are optional (default unknown / {}).
 */
export function parseRulebookCsv(csvText: string): RulebookParseResult {
  const grid = parseCsv(csvText);
  const errors: string[] = [];
  if (grid.length < 2) {
    return { rows: [], errors: ["CSV has no data rows (need a header + ≥1 row)."] };
  }

  const header = grid[0].map((h) => HEADER_ALIASES[norm(h)] ?? norm(h));
  const idx = (k: string) => header.indexOf(k);
  const iPayer = idx("payer");
  const iState = idx("state");
  const iCpt = idx("cpt");
  const iAttr = idx("attribute");
  const iCov = idx("coverage");
  const iVal = idx("value");

  const missingCols = [
    iState < 0 && "state",
    iCpt < 0 && "cpt",
    iAttr < 0 && "attribute",
  ].filter(Boolean);
  if (missingCols.length) {
    return {
      rows: [],
      errors: [`Missing required column(s): ${missingCols.join(", ")}. Found: ${header.join(", ")}`],
    };
  }

  const rows: ParsedRulebookRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const ln = r + 1;
    const state = (cells[iState] ?? "").trim().toUpperCase();
    const cptCode = (cells[iCpt] ?? "").trim().toUpperCase();
    const attrRaw = norm(cells[iAttr] ?? "");
    const attribute = ATTR_SYNONYM[attrRaw];
    if (!/^[A-Z]{2}$/.test(state)) { errors.push(`Row ${ln}: bad state "${cells[iState]}"`); continue; }
    if (!/^[A-Z0-9]{4,5}$/.test(cptCode)) { errors.push(`Row ${ln}: bad CPT "${cells[iCpt]}"`); continue; }
    if (!attribute) {
      errors.push(`Row ${ln}: unknown attribute "${cells[iAttr]}" (valid: ${RULEBOOK_ATTRIBUTES.join(", ")})`);
      continue;
    }
    const covRaw = norm(iCov >= 0 ? cells[iCov] ?? "" : "");
    const coverageStatus: CoverageStatus =
      COVERAGE_SYNONYM[covRaw] ??
      (COVERAGE_STATUSES.includes(covRaw as CoverageStatus)
        ? (covRaw as CoverageStatus)
        : "unknown");
    const valueText = iVal >= 0 ? (cells[iVal] ?? "").trim() : "";
    rows.push({
      payerRef: iPayer >= 0 ? (cells[iPayer] ?? "").trim() || null : null,
      state,
      cptCode,
      attribute,
      coverageStatus,
      ruleValue: valueText ? { answer: valueText } : {},
    });
  }
  return { rows, errors };
}

/**
 * Split free text into overlapping fixed-size chunks for embedding.
 * Splits on paragraph boundaries first, then hard-wraps long blocks.
 */
export function chunkText(
  text: string,
  opts: { maxChars?: number; overlap?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = opts.overlap ?? 150;
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length <= maxChars) {
      buf = buf ? `${buf}\n\n${p}` : p;
      continue;
    }
    if (buf) chunks.push(buf);
    if (p.length <= maxChars) {
      buf = p;
    } else {
      for (let i = 0; i < p.length; i += maxChars - overlap) {
        chunks.push(p.slice(i, i + maxChars));
      }
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
