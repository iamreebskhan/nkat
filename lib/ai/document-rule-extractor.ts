/**
 * Extract structured payer rules from a policy document using Claude.
 *
 * Powers Sources 1 (CMS Final Rule / NCD / LCD) and 2 (commercial
 * payer public policies). One engine; the only difference between the
 * two sources is which URL the operator configures.
 *
 * Input can be either text (HTML stripped to plain or pre-extracted)
 * or a PDF — Anthropic's messages API accepts PDFs natively as a
 * "document" content block, so no local PDF parser is required.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { withTransientRetry } from "./anthropic.client";
import { assertNoPhi } from "./phi-guard";
import { env } from "@/lib/env";

// Opus 4.8 — most capable extraction, best on dense regulatory prose (the
// CY2026 PFS final rule). The native-PDF size limit (600 pages / 32 MB) is the
// same across all 1M-context models, so chunking — not the model — is what
// lets us ingest large rules; the model choice governs extraction quality.
const EXTRACTION_MODEL = "claude-opus-4-8";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Document rule extraction requires the Anthropic API.",
    );
  }
  _client = new Anthropic({ apiKey, maxRetries: 4 });
  return _client;
}

const ExtractedRule = z.object({
  cptCode: z
    .string()
    .regex(/^([A-Z]\d{4}|\d{4}[A-Z\d]|\d{5})$/),
  attribute: z.enum([
    "covered",
    "prior_auth",
    "telehealth",
    "provider_type",
    "billing_limit",
    "addon_compatible",
    "documentation",
    "frequency_limit",
    "modifier_required",
  ]),
  coverageStatus: z.enum(["covered", "not_covered", "varies", "unknown"]),
  /** Plain-English summary of the rule. */
  answer: z.string().min(1).max(500),
  /** Verbatim quote from the document that supports this extraction. */
  sourceQuote: z.string().min(8).max(800),
});
export type ExtractedRule = z.infer<typeof ExtractedRule>;

const ExtractionResponse = z.object({
  rules: z.array(ExtractedRule).max(500),
});

export interface ExtractInput {
  /** Use ONE of these. */
  textContent?: string;
  pdfBase64?: string;
  /** Optional context to focus extraction (the model uses it as a hint). */
  payerName?: string;
  state?: string;
  documentTitle?: string;
}

/**
 * Send a document to Claude and ask it to extract structured payer
 * rules. Returns an empty array if the document has no extractable
 * rules — never invents content.
 */
export async function extractRulesFromDocument(
  input: ExtractInput,
): Promise<ExtractedRule[]> {
  if (!input.textContent && !input.pdfBase64) {
    throw new Error("extractRulesFromDocument: textContent or pdfBase64 required");
  }
  if (input.textContent) assertNoPhi(input.textContent, "ruleExtractor");

  const focus = [
    input.payerName && `Payer: ${input.payerName}`,
    input.state && `State: ${input.state}`,
    input.documentTitle && `Document: ${input.documentTitle}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt =
    "Extract every payer billing rule about CPT or HCPCS codes that this document explicitly states. " +
    "Return JSON ONLY — no prose, no markdown fences — matching this schema:\n" +
    '{ "rules": [ { "cptCode": "99349", "attribute": "covered" | "prior_auth" | "telehealth" | "provider_type" | "billing_limit" | "addon_compatible" | "documentation" | "frequency_limit" | "modifier_required", "coverageStatus": "covered" | "not_covered" | "varies" | "unknown", "answer": "plain-English summary of the rule", "sourceQuote": "verbatim quote from the document supporting this rule" } ] }\n' +
    "Rules:\n" +
    "  - Only include rules you can support with a verbatim quote from the document.\n" +
    "  - Do NOT invent rules. If the document is silent on a code/attribute, omit it.\n" +
    "  - If unsure, set coverageStatus to 'varies' or 'unknown' and explain in answer.\n" +
    "  - Max 500 rules per document.\n" +
    (focus ? `Context:\n${focus}\n` : "");

  const userBlocks: Anthropic.MessageParam["content"] = [];
  if (input.pdfBase64) {
    userBlocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: input.pdfBase64,
      },
    });
  } else if (input.textContent) {
    // Hard cap — Claude has token limits. ~180k chars ≈ 45k tokens, leaves headroom.
    const trimmed = input.textContent.slice(0, 180_000);
    userBlocks.push({ type: "text", text: trimmed });
  }
  userBlocks.push({ type: "text", text: prompt });

  const resp = await withTransientRetry(() =>
    client().messages.create({
      model: EXTRACTION_MODEL,
      // Headroom for dense chunks (a 40-page rule section can yield many
      // rules). Non-streaming is fine at this size.
      max_tokens: 16384,
      system:
        "You are a payer-policy parser. Cite verbatim quotes for every rule. " +
        "Respond with ONLY the JSON object — no preamble, no reasoning, no " +
        "explanation, no markdown fences. Your entire response must be valid JSON.",
      messages: [{ role: "user", content: userBlocks }],
    }),
  );

  const block = resp.content[0];
  if (!block || block.type !== "text") {
    throw new Error("extractRulesFromDocument: unexpected response shape");
  }
  let text = block.text.trim();
  // Defensive: strip ```json fences if the model adds them despite instructions.
  text = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Some models include a brief intro; try to find the first JSON object.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error("extractRulesFromDocument: response is not JSON");
    }
    raw = JSON.parse(text.slice(start, end + 1));
  }
  const parsed = ExtractionResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "extractRulesFromDocument: schema mismatch — " +
        parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
    );
  }
  // Anti-hallucination guard: when we have the source TEXT, keep only rules
  // whose sourceQuote actually appears (case/space-insensitive) in the
  // document. Claude is instructed to quote verbatim; this enforces it so a
  // fabricated quote can never reach the corpus. (PDF path: Claude sees the
  // PDF natively and we don't have the text, so we can't cross-check there.)
  if (input.textContent) {
    const hay = input.textContent.toLowerCase().replace(/\s+/g, " ");
    const grounded = parsed.data.rules.filter((r) => {
      const q = (r.sourceQuote || "").toLowerCase().replace(/\s+/g, " ").trim();
      return q.length >= 8 && hay.includes(q);
    });
    return grounded;
  }
  return parsed.data.rules;
}
