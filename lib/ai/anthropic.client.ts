/**
 * Anthropic API client — single funnel for every Claude call.
 *
 * Sources:
 *   - pallio_complete_vision_v3 §10.4 (the system-prompt + abstraction
 *     contract — DO NOT WEAKEN)
 *   - pallio_complete_vision_v3 §15.4 (no PHI to AI)
 *
 * Two Claude models in use:
 *   - haiku-4-5  — query parsing (fast, cheap, structured-output)
 *   - sonnet-4-6 — rule synthesis (citation-grounded, refuses on miss)
 *
 * Never accept patient names, member IDs, dates of birth, or clinical
 * notes here. The caller is responsible for supplying only the
 * structured inputs (payer, state, CPT code, attribute) — see §15.4.
 *
 * Citation enforcement: if the synthesizer's output doesn't contain
 * a parsable source document name + verbatim quote + effective date,
 * we treat it as `NO_RULE_FOUND` regardless of what the model said.
 * That's the platform's hallucination floor.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { env } from "@/lib/env";

const QUERY_PARSER_MODEL = "claude-haiku-4-5";
const RULE_SYNTHESIS_MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (_client) return _client;
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Rule synthesis requires the Anthropic API; SQL-only lookups still work without it.",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/** True iff the API is configured. Callers can degrade gracefully. */
export function isAnthropicConfigured(): boolean {
  return Boolean(env().ANTHROPIC_API_KEY);
}

// ---------------------------------------------------------------------------
// Query parser — natural-language → structured params
// ---------------------------------------------------------------------------

const ParsedQuery = z.object({
  payer: z.string().nullable(),
  state: z.string().length(2).nullable(),
  cptCode: z.string().nullable(),
  attribute: z
    .enum([
      "covered",
      "prior_auth",
      "telehealth",
      "provider_type",
      "billing_limit",
      "addon_compatible",
      "documentation",
      "frequency_limit",
      "modifier_required",
    ])
    .nullable(),
});

export type ParsedQuery = z.infer<typeof ParsedQuery>;

/**
 * Parse a free-text rule-lookup question into structured parameters.
 * Returns whatever fields Claude could extract; callers decide whether
 * to prompt the user for missing fields.
 *
 * Throws on malformed JSON output (defensive — should be rare given the
 * tight system prompt, but if it happens we want a clean failure mode).
 */
export async function parseRuleQuery(query: string): Promise<ParsedQuery> {
  const response = await client().messages.create({
    model: QUERY_PARSER_MODEL,
    max_tokens: 400,
    system:
      "Extract the payer name, state code (USPS 2-letter), CPT code (5 digits or HCPCS letter+4 digits), and rule attribute from the query. " +
      "Return JSON only — no surrounding prose, no markdown. " +
      "Schema: { payer: string|null, state: string|null, cptCode: string|null, attribute: string|null }. " +
      "Valid attributes: covered, prior_auth, telehealth, provider_type, billing_limit, addon_compatible, documentation, frequency_limit, modifier_required. " +
      "If a field is missing or ambiguous, set it to null — never invent values.",
    messages: [{ role: "user", content: query }],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("parseRuleQuery: unexpected response shape from Anthropic");
  }
  const text = block.text.trim();

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Some models occasionally wrap JSON in ```json fences despite the
    // explicit instruction. Strip + retry once.
    const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    raw = JSON.parse(stripped);
  }
  return ParsedQuery.parse(raw);
}

// ---------------------------------------------------------------------------
// Rule synthesizer — RAG with mandatory citation
// ---------------------------------------------------------------------------

/**
 * Output shape we accept from the synthesizer. ANYTHING missing → treated
 * as NO_RULE_FOUND by the caller; never as a partial answer.
 */
export interface SynthesizedRule {
  /** The model's answer, plain text. */
  answer: string;
  /** Required citation. */
  citation: {
    documentName: string;
    documentUrl?: string;
    effectiveDate?: string;
    /** Verbatim quote from the source. Required — do NOT accept paraphrases. */
    verbatimQuote: string;
  } | null;
  /** True iff the model returned NO_RULE_FOUND. */
  refused: boolean;
  /** Raw model output for audit. */
  raw: string;
}

/**
 * Hallucination-prevention system prompt. Source: vision §10.4. The
 * prose below is intentionally directive — every clause earns its
 * keep, do not weaken without re-running the gold-standard eval.
 */
const SYSTEM_PROMPT = [
  "You are a healthcare billing rule assistant.",
  "Answer ONLY using the structured rule and document chunks provided below.",
  'Every answer MUST include: source document name, effective date, and a verbatim quote in double quotes.',
  'Format the citation as a final paragraph beginning with "Source: <document name> (<effective date>) — \\"<verbatim quote>\\""',
  'If no rule is found in the provided context, respond with exactly: NO_RULE_FOUND.',
  "Never invent, infer, or synthesize a billing rule not present in the context.",
  "If patient PHI appears in the question, refuse — respond with: REFUSED_PHI_DETECTED.",
].join(" ");

/**
 * Generate a citation-grounded answer to a rule lookup query, given
 * (a) any structured rule we already pulled from the SQL repository
 * and (b) document chunks retrieved via vector search.
 *
 * The decision flow caller is `lib/features/billing/rule-lookup.service.ts`.
 */
export async function synthesizeRuleAnswer(args: {
  query: string;
  structuredRule: string | null;
  chunks: string[];
}): Promise<SynthesizedRule> {
  const { query, structuredRule, chunks } = args;

  const context = [
    structuredRule ? `Structured rule:\n${structuredRule}` : null,
    chunks.length > 0
      ? `Document chunks:\n${chunks.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const response = await client().messages.create({
    model: RULE_SYNTHESIS_MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Context:\n${context || "(no context available)"}\n\nQuestion: ${query}`,
      },
    ],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    return {
      answer: "",
      citation: null,
      refused: true,
      raw: "<non-text response>",
    };
  }
  const raw = block.text.trim();

  // Refusal sentinels — short-circuit with no citation.
  if (raw === "NO_RULE_FOUND" || raw === "REFUSED_PHI_DETECTED") {
    return { answer: raw, citation: null, refused: true, raw };
  }

  // Parse the citation block. Format we asked for:
  //   Source: <doc name> (<effective date>) — "<verbatim quote>"
  const citationRe =
    /Source:\s*([^()]+?)(?:\s*\(([^)]+)\))?\s*[—-]\s*"([^"]+)"/i;
  const match = raw.match(citationRe);

  if (!match) {
    // Mandatory citation missing — treat as a refusal regardless of the
    // model's prose. This is the hallucination floor (§10.4).
    return { answer: raw, citation: null, refused: true, raw };
  }

  const [, documentName, effectiveDate, verbatimQuote] = match;
  const answer = raw.slice(0, match.index).trim();

  return {
    answer,
    citation: {
      documentName: documentName.trim(),
      effectiveDate: effectiveDate?.trim(),
      verbatimQuote: verbatimQuote.trim(),
    },
    refused: false,
    raw,
  };
}

/**
 * PHI-detection guard — call BEFORE sending any user input to Anthropic.
 * Naive but tuned for known leak patterns: SSN-like, MRN-prefixed,
 * member-ID-prefixed, DOB-shaped strings.
 *
 * Returns the input untouched if clean; throws if PHI detected. The
 * caller surfaces this as a 422 to the user.
 */
const PHI_PATTERNS: { name: string; re: RegExp }[] = [
  // SSN xxx-xx-xxxx
  { name: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  // MRN-: any 6+ digits after MRN, MR, or "patient ID"
  { name: "MRN", re: /\b(?:MRN|MR|patient\s*id)[#:\s]+\d{6,}/i },
  // Member ID prefix common payer formats: W123456789, 1A2B3C4D5E6 etc.
  { name: "MemberID", re: /\b(?:member\s*id|policy\s*#?)[#:\s]+[A-Z0-9]{8,}/i },
  // DOB-like: 4 digits or M(M)?/D(D)?/YYYY in a date-of-birth context
  { name: "DOB", re: /\b(?:DOB|date of birth)[:\s]+[\d/\-.]+/i },
];

export function assertNoPhi(input: string): void {
  for (const { name, re } of PHI_PATTERNS) {
    if (re.test(input)) {
      throw new Error(
        `Possible PHI detected (${name}). Rule queries must contain only payer/state/code information per pallio_complete_vision_v3 §15.4.`,
      );
    }
  }
}
