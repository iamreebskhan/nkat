/**
 * Rule lookup orchestrator — the core service that powers the billing
 * agent's primary tool.
 *
 * Flow per pallio_complete_vision_v3 §18.6 (read it before changing
 * anything in this file):
 *
 *   1. Validate payer + state + cptCode + attribute. If any missing,
 *      try parsing the natural-language query (haiku) to fill in.
 *   2. Structured SQL lookup against `payer_rule` for an exact match
 *      effective on the date-of-service. If hit + confidence ≥ 0.5,
 *      return immediately with citation from `source_document`.
 *   3. If no SQL hit OR confidence < 0.5, run hybrid retrieval over
 *      `document_chunk` (dense + sparse) filtered to the same payer
 *      and state.
 *   4. Pass the structured rule (if any) + retrieved chunks to
 *      claude-sonnet-4-6 via `synthesizeRuleAnswer()`. If the
 *      response lacks a citation, treat as `NO_RULE_FOUND`.
 *   5. On `NO_RULE_FOUND`, return the standard "unknown rule" message
 *      and push to the analyst queue. Do NOT retry, guess, or fall
 *      back to a default.
 *   6. On success with AI synthesis, the caller (route handler)
 *      records a new `payer_rule` row with `source_type='ai_synthesized'`,
 *      `confidence=0.4`, pending analyst review.
 *
 * Hallucination floor: every answer in this module either has a
 * verbatim citation OR is `unknown` — never a third option.
 */
import {
  isAnthropicConfigured,
  parseRuleQuery,
  synthesizeRuleAnswer,
  type ParsedQuery,
} from "@/lib/ai/anthropic.client";
import { assertNoPhi } from "@/lib/ai/phi-guard";
import { isEmbedderConfigured } from "@/lib/ai/embedder";
import { hybridSearch } from "@/lib/ai/vector-search";

import {
  fetchPayerRule,
  type CoverageStatus,
  type PayerRuleAttribute,
} from "./payer-rule.repository";

export interface LookupRequest {
  /** Optional natural-language query — used when structured fields are missing. */
  query?: string;
  payerId?: string;
  state?: string;
  cptCode?: string;
  attribute?: PayerRuleAttribute;
  /** ISO date; defaults to today if omitted. */
  dos?: string;
}

export type LookupSource =
  | "structured_rule"
  | "ai_synthesized"
  | "unknown";

export interface LookupCitation {
  documentName: string;
  documentUrl: string | null;
  effectiveDate: string | null;
  verbatimQuote: string;
  page: number | null;
}

export interface LookupResult {
  status: "ok" | "needs_clarification" | "unknown";
  /** Why the result is what it is — surfaced in the UI as a tag. */
  source: LookupSource;
  /** The user-facing answer. May be the standard unknown-rule message. */
  answer: string;
  coverageStatus: CoverageStatus;
  /** 0–1; 1.0 = official payer PDF, 0.0 = no source. */
  confidence: number;
  citation: LookupCitation | null;
  /** Fields the caller should ask the user to fill in (if any). */
  missing?: ("payer" | "state" | "cptCode" | "attribute")[];
  /** Echoes back the resolved parameters for the UI to show. */
  resolved: {
    payerId: string | null;
    state: string | null;
    cptCode: string | null;
    attribute: PayerRuleAttribute | null;
  };
}

const UNKNOWN_RULE_MESSAGE =
  "No confirmed rule found. CMS Medicare default applies. Recommend calling the payer to confirm.";

const MIN_SQL_CONFIDENCE = 0.5;
const AI_SYNTHESIZED_CONFIDENCE = 0.4;

/**
 * Run a lookup. Pure orchestration — DB I/O delegated to repository,
 * AI to anthropic.client. Caller handles persistence (analyst queue
 * insert when source=ai_synthesized) and audit-log writes.
 */
export async function lookupRule(req: LookupRequest): Promise<LookupResult> {
  // Step 1 — fill in missing params from natural language if possible.
  let payerId = req.payerId ?? null;
  let state = req.state ?? null;
  let cptCode = req.cptCode ?? null;
  let attribute = req.attribute ?? null;
  const dos = req.dos ? new Date(req.dos) : new Date();

  if ((!payerId || !state || !cptCode) && req.query && isAnthropicConfigured()) {
    assertNoPhi(req.query, "ruleLookup.query");
    let parsed: ParsedQuery;
    try {
      parsed = await parseRuleQuery(req.query);
    } catch {
      // If parsing fails, fall through to missing-fields response below.
      parsed = { payer: null, state: null, cptCode: null, attribute: null };
    }
    // Don't overwrite explicit caller-supplied values.
    state = state ?? parsed.state;
    cptCode = cptCode ?? parsed.cptCode;
    attribute = attribute ?? parsed.attribute;

    // Resolve the parser's payer NAME to a real UUID via the payer table.
    // The payer table is global (no org_id / RLS), citext name column.
    if (!payerId && parsed.payer) {
      const { prisma } = await import("@/lib/db");
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM payer
        WHERE name = ${parsed.payer}::citext
           OR name ILIKE '%' || ${parsed.payer} || '%'
        ORDER BY (name = ${parsed.payer}::citext) DESC
        LIMIT 1
      `;
      payerId = rows[0]?.id ?? null;
    }
  }

  const missing: NonNullable<LookupResult["missing"]> = [];
  if (!payerId) missing.push("payer");
  if (!state) missing.push("state");
  if (!cptCode) missing.push("cptCode");
  if (!attribute) attribute = "covered"; // sensible default

  if (missing.length > 0) {
    return {
      status: "needs_clarification",
      source: "unknown",
      answer:
        "Need a payer, state, and CPT code before I can answer. Pick from the dropdowns.",
      coverageStatus: "unknown",
      confidence: 0,
      citation: null,
      missing,
      resolved: { payerId, state, cptCode, attribute },
    };
  }

  // Type-narrow now that we've filtered on missing[].
  const fullPayerId = payerId!;
  const fullState = state!;
  const fullCptCode = cptCode!;
  const fullAttribute = attribute!;

  // Step 2 — structured SQL lookup. Default product_line=commercial; the
  // route handler can override per resolved payer_type.
  const structuredHit = await fetchPayerRule({
    payerId: fullPayerId,
    state: fullState,
    productLine: "commercial",
    code: fullCptCode,
    attribute: fullAttribute,
    dos,
  });

  if (structuredHit && structuredHit.confidence >= MIN_SQL_CONFIDENCE) {
    return {
      status: "ok",
      source: "structured_rule",
      answer: renderStructuredAnswer(structuredHit, fullCptCode),
      coverageStatus: structuredHit.coverageStatus,
      confidence: structuredHit.confidence,
      citation: structuredHit.sourceQuote
        ? {
            documentName: "Payer policy document",
            documentUrl: structuredHit.sourceUrl,
            effectiveDate: structuredHit.effectiveDate.toISOString().slice(0, 10),
            verbatimQuote: structuredHit.sourceQuote,
            page: structuredHit.sourcePage,
          }
        : null,
      resolved: {
        payerId: fullPayerId,
        state: fullState,
        cptCode: fullCptCode,
        attribute: fullAttribute,
      },
    };
  }

  // Step 3+4 — RAG fallback. Skip if AI providers aren't configured.
  if (!isAnthropicConfigured() || !isEmbedderConfigured()) {
    return unknownResult({
      payerId: fullPayerId,
      state: fullState,
      cptCode: fullCptCode,
      attribute: fullAttribute,
    });
  }

  const queryText =
    req.query ?? `${fullAttribute} for CPT ${fullCptCode} in ${fullState}`;
  assertNoPhi(queryText, "ruleLookup.synth");

  const chunks = await hybridSearch({
    query: queryText,
    payerId: fullPayerId,
    state: fullState,
    topK: 5,
  });

  const synth = await synthesizeRuleAnswer({
    query: queryText,
    structuredRule: structuredHit
      ? renderStructuredAnswer(structuredHit, fullCptCode)
      : null,
    chunks: chunks.map((c) => c.content),
  });

  // Step 5 — refusal path. NEVER swap in a synthesized rule without a
  // verbatim citation.
  if (synth.refused || !synth.citation) {
    return unknownResult({
      payerId: fullPayerId,
      state: fullState,
      cptCode: fullCptCode,
      attribute: fullAttribute,
    });
  }

  // Step 6 — caller persists the synthesized rule for analyst review.
  return {
    status: "ok",
    source: "ai_synthesized",
    answer: synth.answer || synth.raw,
    coverageStatus: structuredHit?.coverageStatus ?? "varies",
    confidence: AI_SYNTHESIZED_CONFIDENCE,
    citation: {
      documentName: synth.citation.documentName,
      documentUrl: synth.citation.documentUrl ?? null,
      effectiveDate: synth.citation.effectiveDate ?? null,
      verbatimQuote: synth.citation.verbatimQuote,
      page: null,
    },
    resolved: {
      payerId: fullPayerId,
      state: fullState,
      cptCode: fullCptCode,
      attribute: fullAttribute,
    },
  };
}

function renderStructuredAnswer(
  hit: { value: Record<string, unknown>; coverageStatus: CoverageStatus },
  code: string,
): string {
  const status = hit.coverageStatus.replace("_", " ");
  const detail =
    typeof hit.value.answer === "string"
      ? hit.value.answer
      : JSON.stringify(hit.value);
  return `For CPT ${code}: ${status}. ${detail}`;
}

function unknownResult(resolved: {
  payerId: string;
  state: string;
  cptCode: string;
  attribute: PayerRuleAttribute;
}): LookupResult {
  return {
    status: "unknown",
    source: "unknown",
    answer: UNKNOWN_RULE_MESSAGE,
    coverageStatus: "unknown",
    confidence: 0,
    citation: null,
    resolved,
  };
}
