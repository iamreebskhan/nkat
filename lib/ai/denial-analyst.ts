/**
 * AI denial analyst — turns a denial signal into a likely-cause +
 * refile recommendation, citation-grounded.
 *
 * Source: pallio_complete_vision_v3 §6.5 (denial workflow) + §10.4
 * (Anthropic abstraction).
 *
 * Flow:
 *   1. Caller assembles inputs: CPT, payer, state, CARC/RARC,
 *      denial reason text, ICD-10 codes.
 *   2. We run a narrow rule lookup (`payer × state × cpt × covered`)
 *      to fetch any matching `payer_rule` row.
 *   3. Send that structured rule + denial context to claude-sonnet-4-6
 *      with a strict system prompt: cite the rule, recommend one of
 *      [refile, write_off, appeal, unknown].
 *   4. Reject any response missing a citation — fall back to the
 *      heuristic from `denial-pure.lookupCarc()`.
 *
 * Hallucination floor: if the model invents a rule, we drop the
 * answer and log "unknown". Same contract as rule lookup (§5.1).
 */
import Anthropic from "@anthropic-ai/sdk";

import { withTransientRetry } from "@/lib/ai/anthropic.client";
import { assertNoPhi } from "@/lib/ai/phi-guard";
import { fetchPayerRule } from "@/lib/features/billing/payer-rule.repository";
import { describeDenialHeuristic, lookupCarc } from "@/lib/features/denials/denial-pure";
import type { AiRecommendation } from "@/lib/features/denials/denial.types";
import { env } from "@/lib/env";

const MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Denial AI analysis requires Anthropic.",
    );
  }
  _client = new Anthropic({ apiKey, maxRetries: 4 });
  return _client;
}

export function isAnalystConfigured(): boolean {
  return Boolean(env().ANTHROPIC_API_KEY);
}

export interface DenialAnalysisInput {
  cptCode: string;
  payerId: string | null;
  state: string | null;
  carcCode: string;
  rarcCode?: string | null;
  denialReason?: string | null;
  deniedAmountCents?: number;
  icd10Codes?: string[];
  /** Service date — used to fetch the rule row that was effective then. */
  dateOfService: Date;
}

export interface DenialAnalysisResult {
  text: string;
  likelyCause: string;
  recommendation: AiRecommendation;
  citation: { documentName: string; verbatimQuote: string } | null;
  modelVersion: string;
  /** True iff the model was actually called (false = heuristic fallback). */
  aiUsed: boolean;
}

const SYSTEM_PROMPT = [
  "You are a healthcare billing denial analyst.",
  "Given a denial signal (CARC/RARC + reason text) and a structured payer rule, produce:",
  "  1. A one-sentence likely cause.",
  "  2. A short paragraph explaining what the payer policy says.",
  "  3. A recommendation — exactly one of: refile, write_off, appeal, unknown.",
  'Format your response as JSON only: {"likely_cause": string, "explanation": string, "recommendation": "refile"|"write_off"|"appeal"|"unknown", "citation": {"document_name": string, "verbatim_quote": string} | null}.',
  "If no payer rule was provided, return citation: null and recommendation: \"unknown\". Never invent a rule.",
  "If you would need PHI to answer, set recommendation to \"unknown\" and explain in `explanation`.",
].join(" ");

/**
 * Analyze a denial. Returns a structured result; if AI isn't
 * configured, falls back to the deterministic heuristic from
 * `lookupCarc()` so the FE always has something to show.
 */
export async function analyzeDenial(
  input: DenialAnalysisInput,
): Promise<DenialAnalysisResult> {
  // Heuristic floor — used both for the fallback and as a sanity
  // anchor next to the AI's recommendation.
  const heuristic = describeDenialHeuristic({
    carcCode: input.carcCode,
    cptCode: input.cptCode,
  });
  const carcEntry = lookupCarc(input.carcCode);

  if (!isAnalystConfigured() || !input.payerId || !input.state) {
    return {
      text: `${heuristic.heuristic} ${carcEntry.category === "auth_required" ? "Likely needs prior authorization on file." : ""}`.trim(),
      likelyCause: heuristic.heuristic,
      recommendation: heuristic.recommendation,
      citation: null,
      modelVersion: "heuristic-v1",
      aiUsed: false,
    };
  }

  // Fetch the rule that was effective at DOS. If absent we still call
  // Claude — the system prompt instructs it to refuse without context,
  // which is the correct behavior.
  const rule = await fetchPayerRule({
    payerId: input.payerId,
    state: input.state,
    productLine: "commercial",
    code: input.cptCode,
    attribute: "covered",
    dos: input.dateOfService,
  });
  const ruleSummary = rule
    ? [
        `Coverage status: ${rule.coverageStatus}`,
        rule.sourceQuote ? `Source quote: "${rule.sourceQuote}"` : null,
        `Effective: ${rule.effectiveDate.toISOString().slice(0, 10)}`,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const userMsg = [
    `Denial signal:`,
    `  CPT: ${input.cptCode}`,
    `  CARC: ${input.carcCode}${input.rarcCode ? ` / RARC: ${input.rarcCode}` : ""}`,
    `  Reason: ${input.denialReason ?? "(none provided)"}`,
    input.icd10Codes && input.icd10Codes.length > 0
      ? `  ICD-10 codes: ${input.icd10Codes.join(", ")}`
      : null,
    "",
    ruleSummary ? `Payer rule (effective at DOS):\n${ruleSummary}` : "Payer rule: NONE_AVAILABLE",
  ]
    .filter(Boolean)
    .join("\n");

  let response: Anthropic.Messages.Message;
  try {
    assertNoPhi(userMsg, "denialAnalyst");
    response = await withTransientRetry(() =>
      client().messages.create({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    );
  } catch {
    // Network / API error — fall back so the workflow doesn't block.
    return {
      text: `${heuristic.heuristic} (AI unavailable; heuristic shown.)`,
      likelyCause: heuristic.heuristic,
      recommendation: heuristic.recommendation,
      citation: null,
      modelVersion: "heuristic-v1",
      aiUsed: false,
    };
  }

  const block = response.content[0];
  if (!block || block.type !== "text") {
    return heuristicFallback(heuristic.heuristic, heuristic.recommendation);
  }

  const raw = block.text.trim();
  const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  let parsed:
    | {
        likely_cause: string;
        explanation: string;
        recommendation: AiRecommendation;
        citation: { document_name: string; verbatim_quote: string } | null;
      }
    | null = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return heuristicFallback(heuristic.heuristic, heuristic.recommendation);
  }
  if (!parsed) return heuristicFallback(heuristic.heuristic, heuristic.recommendation);

  // Hallucination guard: if recommendation isn't one of the allowed
  // values, treat as unknown.
  const allowed: AiRecommendation[] = ["refile", "write_off", "appeal", "unknown"];
  const recommendation = allowed.includes(parsed.recommendation)
    ? parsed.recommendation
    : "unknown";

  // Hallucination guard #2: a non-unknown recommendation REQUIRES a
  // citation when a rule was provided. Without one, fall back.
  if (recommendation !== "unknown" && rule && !parsed.citation) {
    return heuristicFallback(heuristic.heuristic, heuristic.recommendation);
  }

  return {
    text: parsed.explanation,
    likelyCause: parsed.likely_cause,
    recommendation,
    citation: parsed.citation
      ? {
          documentName: parsed.citation.document_name,
          verbatimQuote: parsed.citation.verbatim_quote,
        }
      : null,
    modelVersion: MODEL,
    aiUsed: true,
  };
}

function heuristicFallback(
  cause: string,
  rec: "refile" | "write_off" | "appeal" | "unknown",
): DenialAnalysisResult {
  return {
    text: `${cause} (Falling back to heuristic — model output didn't pass citation check.)`,
    likelyCause: cause,
    recommendation: rec,
    citation: null,
    modelVersion: "heuristic-v1",
    aiUsed: false,
  };
}
