/**
 * Rule lookup orchestrator — the core service that powers the billing
 * agent's primary tool.
 *
 * Flow per pallio_complete_vision_v3 §18.6 (read it before changing
 * anything in this file):
 *
 *   1. Validate payer + state + cptCode + attribute. If any missing,
 *      try parsing the natural-language query (haiku) to fill in.
 *   2. ORG FIRST. Look the cell up in the caller's own rulebook
 *      (`org_rulebook_row`). If they have it, that IS the answer — an
 *      org's documented position outranks the platform's reference
 *      library, because they're the ones who called the payer.
 *   2b. Structured SQL lookup against the global `payer_rule` library
 *      for an exact match effective on the date-of-service. This is
 *      the fallback when the org's rulebook doesn't cover the cell —
 *      and it is ALWAYS fetched regardless, so the answer can carry
 *      the other library's position as `comparison` ("your rulebook
 *      says X, Pallio's library says Y"). Disagreement sets
 *      `conflict`, which the UI surfaces rather than silently
 *      preferring one side.
 *   3. If neither library hits, run hybrid retrieval over
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
  fetchOrgRule,
  type OrgRuleHit,
  type OrgRuleOrigin,
} from "@/lib/features/rulebook/org-rule.repository";

import {
  fetchBenchmarkRules,
  fetchPayerRule,
  type CoverageStatus,
  type PayerRuleAttribute,
  type PayerRuleHit,
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
  /**
   * The caller's org. Required for the org-rulebook step — without it
   * the lookup silently degrades to the global library only, which is
   * exactly the bug this parameter exists to prevent. Callers that
   * genuinely have no tenant (platform tooling) may omit it.
   */
  orgId?: string;
}

export type LookupSource =
  | "org_rulebook"
  | "structured_rule"
  | "ai_synthesized"
  | "unknown";

/**
 * Which library a comparison came from.
 *
 * `benchmark` is NOT a statement about the requested payer. It is what
 * OTHER payers pay for the same code in the same state, shown when the
 * requested payer publishes nothing — the same sanity check a biller
 * does by hand against Medicare before billing a commercial plan.
 */
export type LookupScope = "org_rulebook" | "global_library" | "benchmark";

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
  /**
   * When source='ai_synthesized', the source_document id of the top
   * RAG chunk that supports the answer. Used by the lookup route to
   * persist the synthesized rule with a valid source_doc_id FK
   * (citation.documentUrl alone isn't reliable — Claude only sees
   * chunk content, not URLs).
   */
  sourceDocId?: string | null;
  /**
   * The OTHER library's position on the same cell, for side-by-side
   * display. When the answer came from the org's rulebook this holds
   * the global library's rule; when the answer came from the global
   * library this holds the org's row (normally null, since an org hit
   * would have won). Null when the other side has nothing to say.
   */
  comparison: {
    scope: LookupScope;
    coverageStatus: CoverageStatus;
    answer: string;
    confidence: number;
    citation: LookupCitation | null;
    /** Only for scope='org_rulebook' — how the org got this value. */
    origin?: OrgRuleOrigin;
  } | null;
  /**
   * True when both libraries answered and their coverage_status
   * disagrees. The org answer still wins; this flags the divergence so
   * the biller can see it instead of unknowingly billing against a
   * stale rulebook.
   */
  conflict: boolean;
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
      comparison: null,
      conflict: false,
      missing,
      resolved: { payerId, state, cptCode, attribute },
    };
  }

  // Type-narrow now that we've filtered on missing[].
  const fullPayerId = payerId!;
  const fullState = state!;
  const fullCptCode = cptCode!;
  const fullAttribute = attribute!;

  const resolved = {
    payerId: fullPayerId,
    state: fullState,
    cptCode: fullCptCode,
    attribute: fullAttribute,
  };

  // Steps 2 + 2b — query BOTH libraries. The org's rulebook decides the
  // answer; the global library rides along as `comparison` so the
  // biller always sees both positions. Run them concurrently: they hit
  // different tables and neither depends on the other.
  const [orgHit, structuredHit] = await Promise.all([
    // No orgId (platform tooling) → skip the org library entirely
    // rather than leak another tenant's rulebook.
    req.orgId
      ? fetchOrgRule({
          orgId: req.orgId,
          payerId: fullPayerId,
          state: fullState,
          code: fullCptCode,
          attribute: fullAttribute,
          dos,
        })
      : Promise.resolve(null),
    // Default product_line=commercial; the route handler can override
    // per resolved payer_type.
    fetchPayerRule({
      payerId: fullPayerId,
      state: fullState,
      productLine: "commercial",
      code: fullCptCode,
      attribute: fullAttribute,
      dos,
    }),
  ]);

  const globalUsable =
    structuredHit !== null && structuredHit.confidence >= MIN_SQL_CONFIDENCE;

  // Step 2 — the org's own rulebook wins when it covers the cell.
  if (orgHit) {
    return {
      status: "ok",
      source: "org_rulebook",
      answer: renderOrgAnswer(orgHit, fullCptCode),
      coverageStatus: orgHit.coverageStatus,
      confidence: orgHit.confidence,
      citation: orgHit.sourceQuote
        ? {
            documentName: orgRuleCitationName(orgHit),
            documentUrl: null,
            effectiveDate: orgHit.lastEditedAt
              ? orgHit.lastEditedAt.toISOString().slice(0, 10)
              : null,
            verbatimQuote: orgHit.sourceQuote,
            page: null,
          }
        : null,
      comparison: structuredHit
        ? globalComparison(structuredHit, fullCptCode)
        : null,
      // Only a usable global rule counts as a real disagreement — a
      // sub-threshold row isn't a position worth contradicting.
      conflict:
        globalUsable && structuredHit!.coverageStatus !== orgHit.coverageStatus,
      resolved,
    };
  }

  // Step 2b — fall back to the global reference library.
  if (globalUsable) {
    return {
      status: "ok",
      source: "structured_rule",
      answer: renderStructuredAnswer(structuredHit!, fullCptCode),
      coverageStatus: structuredHit!.coverageStatus,
      confidence: structuredHit!.confidence,
      citation: structuredHit!.sourceQuote
        ? {
            documentName: structuredHit!.isStatewide
              ? "State Medicaid policy"
              : "Payer policy document",
            documentUrl: structuredHit!.sourceUrl,
            effectiveDate: structuredHit!.effectiveDate
              .toISOString()
              .slice(0, 10),
            verbatimQuote: structuredHit!.sourceQuote,
            page: structuredHit!.sourcePage,
          }
        : null,
      // The org had nothing for this cell — say so explicitly rather
      // than leaving the UI to guess why there's no second column.
      comparison: null,
      conflict: false,
      resolved,
    };
  }

  // A structured row below MIN_SQL_CONFIDENCE can't be the answer, but
  // it's still the global library's stated position — carry it into the
  // fallback paths so "unknown" doesn't hide a low-confidence rule the
  // biller might want to chase down.
  const weakGlobal = structuredHit
    ? globalComparison(structuredHit, fullCptCode)
    : null;

  // Nothing published for this payer. Rather than return a bare
  // "Unknown" and throw away what the library does know, fall back to a
  // BENCHMARK: what Medicare, or a Medicaid plan in the same state, pays
  // for this code. Commercial payers publish no public fee schedule, so
  // this is the only reference a biller has — and it is what they would
  // look up manually anyway.
  //
  // The status stays `unknown`, because we genuinely do not know THIS
  // payer's rule. The benchmark rides in `comparison`, explicitly
  // labelled, so it can never be mistaken for the payer's own position.
  const fallback = weakGlobal ?? (await (async () => {
    // A benchmark is a nicety, never load-bearing: if the lookup fails
    // for any reason the answer must still come back, just without the
    // reference. try/catch rather than .catch() so a non-promise return
    // is handled too.
    let marks: Awaited<ReturnType<typeof fetchBenchmarkRules>> = [];
    try {
      marks = (await fetchBenchmarkRules({
        state: fullState, code: fullCptCode, attribute: fullAttribute,
        dos, excludePayerId: fullPayerId,
      })) ?? [];
    } catch {
      marks = [];
    }
    const m = marks[0];
    if (!m) return null;
    return {
      scope: "benchmark" as const,
      coverageStatus: m.coverageStatus,
      // Deliberately not renderStructuredAnswer() — that prefixes "For
      // CPT X: <status>.", which duplicates the sentence above it and
      // reads badly in the panel a biller actually sees.
      answer:
        `No published rule for this payer. For reference, ${m.payerName} ` +
        `${m.coverageStatus === "covered" ? "covers" : m.coverageStatus === "not_covered" ? "does not cover" : "conditionally covers"} ` +
        `CPT ${fullCptCode} in ${fullState}${describeRuleValue(m.value) ? ` — ${describeRuleValue(m.value)}` : "."} ` +
        `This is a reference point, not this payer's rule — confirm with the payer before billing.`,
      confidence: 0,
      citation: m.sourceQuote
        ? {
            documentName: `Benchmark — ${m.payerName}`,
            documentUrl: m.sourceUrl,
            effectiveDate: m.effectiveDate.toISOString().slice(0, 10),
            verbatimQuote: m.sourceQuote,
            page: m.sourcePage,
          }
        : null,
    };
  })());

  // Step 3+4 — RAG fallback. Skip if AI providers aren't configured.
  if (!isAnthropicConfigured() || !isEmbedderConfigured()) {
    return unknownResult(resolved, fallback);
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
    return unknownResult(resolved, fallback);
  }

  // Step 6 — caller persists the synthesized rule for analyst review.
  // Carry the top retrieval chunk's source_doc_id so the route can
  // INSERT payer_rule.source_doc_id without a fragile URL lookup
  // (Claude only saw chunk content, not URLs, so synth.citation
  // documentUrl is unreliable).
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
    sourceDocId: chunks[0]?.docId ?? null,
    comparison: fallback,
    conflict: false,
    resolved,
  };
}

/**
 * Turn a rule's JSONB payload into a sentence a biller can read.
 *
 * The payload shape varies by attribute, so there's no fixed template.
 * Prefer an explicit `answer` string; otherwise flatten the remaining
 * keys into "Label: value" pairs. `covered` is dropped because the
 * coverage status already says it — printing both gave us answers like
 * "covered. {"covered":true}".
 */
function describeRuleValue(value: Record<string, unknown>): string {
  if (typeof value.answer === "string" && value.answer.trim()) {
    return value.answer.trim();
  }
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (key === "answer" || key === "covered") continue;
    if (raw === null || raw === undefined || raw === "") continue;
    const label = key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    const rendered =
      typeof raw === "boolean"
        ? raw
          ? "yes"
          : "no"
        : Array.isArray(raw)
          ? raw.join(", ")
          : typeof raw === "object"
            ? JSON.stringify(raw)
            : String(raw);
    // A note/detail field is already a sentence — don't label it.
    parts.push(/^(note|notes|detail|details)$/i.test(key) ? rendered : `${label}: ${rendered}`);
  }
  return parts.join(". ");
}

function renderStructuredAnswer(
  hit: { value: Record<string, unknown>; coverageStatus: CoverageStatus },
  code: string,
): string {
  const status = hit.coverageStatus.replace("_", " ");
  const detail = describeRuleValue(hit.value);
  return detail
    ? `For CPT ${code}: ${status}. ${detail}`
    : `For CPT ${code}: ${status}.`;
}

/** Human label for where an org rulebook value came from. */
function orgRuleCitationName(hit: OrgRuleHit): string {
  switch (hit.origin) {
    case "analyst":
      return "Your analyst attestation (payer call)";
    case "org_override":
      return "Your rulebook (manual override)";
    case "org_upload":
      return "Your uploaded rulebook";
    default:
      return "Your rulebook";
  }
}

function renderOrgAnswer(hit: OrgRuleHit, code: string): string {
  const status = hit.coverageStatus.replace("_", " ");
  const detail = describeRuleValue(hit.value);
  const prefix = `Per your rulebook, CPT ${code}: ${status}.`;
  return detail ? `${prefix} ${detail}` : prefix;
}

/** Package a global-library hit for the side-by-side comparison slot. */
function globalComparison(
  hit: PayerRuleHit,
  code: string,
): NonNullable<LookupResult["comparison"]> {
  return {
    scope: "global_library",
    coverageStatus: hit.coverageStatus,
    answer: renderStructuredAnswer(hit, code),
    confidence: hit.confidence,
    citation: hit.sourceQuote
      ? {
          documentName: hit.isStatewide
            ? "Pallio rule library — state Medicaid policy"
            : "Pallio rule library",
          documentUrl: hit.sourceUrl,
          effectiveDate: hit.effectiveDate.toISOString().slice(0, 10),
          verbatimQuote: hit.sourceQuote,
          page: hit.sourcePage,
        }
      : null,
  };
}

function unknownResult(
  resolved: {
    payerId: string;
    state: string;
    cptCode: string;
    attribute: PayerRuleAttribute;
  },
  comparison: LookupResult["comparison"] = null,
): LookupResult {
  return {
    status: "unknown",
    source: "unknown",
    answer: UNKNOWN_RULE_MESSAGE,
    coverageStatus: "unknown",
    confidence: 0,
    citation: null,
    comparison,
    conflict: false,
    resolved,
  };
}
