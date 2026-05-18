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
import { assertNoPhi } from "./phi-guard";

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
/**
 * Domain-aware parser prompt. A billing agent asks in plain terms
 * ("Medicare prolonged service add-on", "ACP add-on for another 30
 * min") — the parser must resolve the described service to its
 * code, not just scrape literal digits. Catalog + decision rules are
 * the palliative set seeded in db/seed/0007_palliative_codes.sql.
 */
const PARSER_SYSTEM_PROMPT = [
  "You extract structured billing-rule lookup parameters from a billing agent's question.",
  "Return JSON ONLY — no prose, no markdown.",
  'Schema: { "payer": string|null, "state": string|null, "cptCode": string|null, "attribute": string|null }',
  "state = USPS 2-letter (Ohio→OH). payer = the plan/insurer name as written (Humana, Aetna, Medicare, Anthem).",
  "",
  "CPT/HCPCS catalog (resolve a DESCRIBED service to its code):",
  "  99341/99342/99344/99345 = home visit, NEW patient (15/30/60/75 min, low/low/mod/high).",
  "  99347/99348/99349/99350 = home visit, ESTABLISHED patient (20/30/40/60 min).",
  "  99497 = advance care planning (ACP), FIRST 30 min.",
  "  99498 = ACP ADD-ON, each ADDITIONAL 30 min.",
  "  G0318 = Medicare longitudinal palliative care / Medicare prolonged home-visit service.",
  "  99417 = NON-Medicare (commercial) prolonged service add-on.",
  "",
  "Resolution rules:",
  '  - "prolonged service add-on": Medicare → G0318; non-Medicare/commercial → 99417.',
  '  - "ACP"/"advance care planning" alone or 30 min → 99497; "ACP add-on"/"additional 30 min"/"each additional" → 99498.',
  "  - New-patient home visit by time: 15→99341, 30→99342, 60→99344, 75→99345.",
  "  - Established-patient home visit by time: 20→99347, 30→99348, 40→99349, 60→99350.",
  "  - Medicare + home-visit time beyond the 60-min level (e.g. 70 min) → G0318.",
  "  - If the question names or compares MULTIPLE codes (\"99348 vs 99349\", \"difference between X and Y\"), return the FIRST one.",
  "",
  "attribute ∈ { covered, prior_auth, telehealth, provider_type, billing_limit, addon_compatible, documentation, frequency_limit, modifier_required }. Infer from intent:",
  "  - who can bill / social worker / NP vs MD / provider eligibility → provider_type",
  "  - consent wording / statement / what must I document / note requirements → documentation",
  "  - authorization / pre-auth / prior auth → prior_auth",
  "  - virtual / video / phone / modifier 95 / telehealth → telehealth (UNLESS it's about consent WORDING → documentation)",
  "  - rate / how much / total billable / units → billing_limit",
  "  - can I bill X with Y / add-on / bundled → addon_compatible",
  "  - how often / per day / per year / frequency → frequency_limit",
  "  - which modifier / modifier required → modifier_required",
  "  - otherwise → covered",
  "",
  "Only set a field null when it genuinely cannot be inferred. Never invent a payer or state that isn't implied.",
].join("\n");

export async function parseRuleQuery(query: string): Promise<ParsedQuery> {
  assertNoPhi(query, "parseRuleQuery");
  const response = await client().messages.create({
    model: QUERY_PARSER_MODEL,
    max_tokens: 400,
    system: PARSER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: query }],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("parseRuleQuery: unexpected response shape from Anthropic");
  }
  const text = block.text.trim();
  return ParsedQuery.parse(extractJsonObject(text));
}

/**
 * Robustly pull the first balanced JSON object out of a model
 * response. Haiku usually returns bare JSON, but despite the
 * "JSON only" instruction it sometimes wraps it in ```json fences or
 * appends an explanation after the closing brace (which made a naive
 * JSON.parse throw "Unexpected non-whitespace character after JSON").
 * Strategy: strip code fences, then scan for the first '{' and walk
 * braces (quote/escape aware) to its matching '}', parsing only that.
 */
export function extractJsonObject(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    /* fall through to brace scan */
  }
  const start = unfenced.indexOf("{");
  if (start === -1) {
    throw new Error("parseRuleQuery: no JSON object in model response");
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < unfenced.length; i++) {
    const c = unfenced[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(unfenced.slice(start, i + 1));
      }
    }
  }
  throw new Error("parseRuleQuery: unterminated JSON object in model response");
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

  assertNoPhi([query, context], "synthesizeRuleAnswer");
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

// Pre-launch PHI guard moved to lib/ai/phi-guard.ts (Phase 7) — kept
// the import + call sites; the regex set there is more comprehensive.
