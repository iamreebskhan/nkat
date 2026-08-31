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
    "pos_allowed",
  ]),
  coverageStatus: z.enum(["covered", "not_covered", "varies", "unknown"]),
  /** Plain-English summary of the rule. */
  answer: z.string().min(1).max(500),
  /** Verbatim quote from the document that supports this extraction. */
  sourceQuote: z.string().min(8).max(800),
});
export type ExtractedRule = z.infer<typeof ExtractedRule>;

/**
 * The envelope only — every rule left unvalidated so they can be checked one
 * at a time.
 *
 * Validating the whole array at once made ANY single unrecognised code
 * destroy the entire document's extraction. Measured on NC Medicaid's hospice
 * policy: the model returned rules, three carried codes the CPT/HCPCS pattern
 * rejects, safeParse failed on the object, and all of them were thrown away —
 * reported as "no rules", from a document a person had already pulled rules
 * out of by hand.
 *
 * A hospice policy is exactly where this bites: it lists revenue codes (0651,
 * 0652, 0656), which are four digits and correctly are NOT CPT or HCPCS. The
 * validator was right about those three. Its blast radius was wrong.
 */
const ExtractionEnvelope = z.object({
  rules: z.array(z.unknown()).max(500),
});

export interface ExtractInput {
  /** Use ONE of these. */
  textContent?: string;
  pdfBase64?: string;
  /**
   * REQUIRED alongside pdfBase64: the PDF's text layer, for the PHI guard.
   *
   * Claude still receives the PDF itself — it reads layout, tables and
   * scanned pages far better than a text layer — so this is never what gets
   * sent. It exists because the guard cannot read a base64 blob, and a
   * document nobody can screen must not be a document that gets sent.
   * Extracted by lib/features/documents/pdf-text.ts.
   */
  pdfText?: string;
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
  // "document" mode: this is a third-party page fetched from a payer's
  // public URL, not a prompt we composed from our own data. See the note
  // at the top of phi-guard.ts for why the two are scanned differently.
  //
  // The screening happens HERE, at the boundary where the payload leaves for
  // Anthropic, and not in the ingestion service that happens to call it — so
  // there is no route to the API that skips it. That mattered: for as long as
  // PDFs were screened nowhere, every PDF source went out unread, and nothing
  // in the type system said so.
  if (input.textContent) {
    assertNoPhi(input.textContent, "ruleExtractor", "document");
  }
  if (input.pdfBase64) {
    // Fail closed. An unscreenable PDF is not a PDF we are allowed to send,
    // and the caller has to have done the extraction to prove otherwise.
    if (input.pdfText === undefined) {
      throw new Error(
        "extractRulesFromDocument: pdfBase64 requires pdfText for PHI screening. " +
          "Extract it with extractPdfText() and pass it; do not omit it to get " +
          "past this — an unscreened document is the thing the guard exists for.",
      );
    }
    assertNoPhi(input.pdfText, "ruleExtractor.pdf", "document");
  }

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
    '{ "rules": [ { "cptCode": "99349", "attribute": "covered" | "prior_auth" | "telehealth" | "provider_type" | "billing_limit" | "addon_compatible" | "documentation" | "frequency_limit" | "modifier_required" | "pos_allowed", "coverageStatus": "covered" | "not_covered" | "varies" | "unknown", "answer": "plain-English summary of the rule", "sourceQuote": "verbatim quote from the document supporting this rule" } ] }\n' +
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
      //
      // Raised from 16384, which a real document exceeded: Aetna's
      // telemedicine payment policy filled the budget mid-array and the reply
      // arrived as invalid JSON. Not raised further because output length is
      // latency, and a run that outlives the edge timeout has its own
      // problems — recoverTruncatedRules below is the real answer to a reply
      // that runs out of room.
      max_tokens: 32_000,
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
  } catch (parseError) {
    // Some models include a brief intro; try to find the first JSON object.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    let recovered: unknown = null;
    if (start !== -1 && end !== -1) {
      try {
        recovered = JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through to the truncation path */
      }
    }
    if (recovered !== null) {
      raw = recovered;
    } else {
      // A REPLY THAT RAN OUT OF ROOM, not a reply that is malformed.
      //
      // max_tokens cut Aetna's telemedicine policy off mid-array. Both parse
      // attempts then failed — the second because a truncated array's last
      // "}" closes a half-written rule — and the whole document was thrown
      // away with "Expected ',' or ']' after array element in JSON at
      // position 38375". Every rule the model HAD finished writing was lost
      // with it, which is the same mistake as validating the rules array as
      // one unit: a problem at the end taking out everything before it.
      const salvaged = recoverTruncatedRules(text);
      const truncated = resp.stop_reason === "max_tokens";
      if (salvaged.length === 0) {
        throw new Error(
          truncated
            ? `extractRulesFromDocument: the reply hit the ${32_000}-token output limit ` +
              `before a single complete rule — the document is too dense to extract in one pass`
            : `extractRulesFromDocument: response is not JSON — ` +
              `${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
      }
      console.warn(
        `extractRulesFromDocument: reply was ${truncated ? "truncated at the output limit" : "unparseable"}; ` +
          `recovered ${salvaged.length} complete rule(s) from it`,
      );
      raw = { rules: salvaged };
    }
  }
  // The ENVELOPE must be right — no rules array means the model did not
  // answer the question, and there is nothing to salvage.
  const envelope = ExtractionEnvelope.safeParse(raw);
  if (!envelope.success) {
    throw new Error(
      "extractRulesFromDocument: schema mismatch — " +
        envelope.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
    );
  }

  // Then each rule ON ITS OWN. One unusable entry drops itself and nothing
  // else; previously it took the whole document with it.
  const kept: ExtractedRule[] = [];
  const dropped: string[] = [];
  for (const candidate of envelope.data.rules) {
    const one = ExtractedRule.safeParse(candidate);
    if (one.success) {
      kept.push(one.data);
      continue;
    }
    // Name what was dropped and why. A run that quietly discards half a
    // document while reporting success is how "0 rules" went unexplained for
    // as long as it did.
    const code =
      candidate && typeof candidate === "object" && "cptCode" in candidate
        ? String((candidate as { cptCode: unknown }).cptCode).slice(0, 16)
        : "(no cptCode)";
    dropped.push(`${code}: ${one.error.issues[0]?.message ?? "invalid"}`);
  }
  if (dropped.length) {
    console.warn(
      `extractRulesFromDocument: dropped ${dropped.length}/${envelope.data.rules.length} ` +
        `rule(s) that do not fit the CPT/HCPCS shape (revenue codes, ranges and ` +
        `free text land here): ${dropped.slice(0, 10).join(" | ")}`,
    );
  }
  const parsed = { success: true as const, data: { rules: kept } };
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

/**
 * Pull the complete rule objects out of a reply that stopped mid-array.
 *
 * When max_tokens cuts the model off, the JSON is unparseable and everything
 * in it is lost — including every rule the model had already finished. That
 * is the all-or-nothing failure again, one level up: the schema check learned
 * to judge rules one at a time, and then the PARSE still judged them as a
 * block.
 *
 * So walk the rules array and keep whatever closed properly. Brace depth,
 * with string and escape state tracked, because a quote inside a
 * sourceQuote — and payer prose is full of them — would otherwise make the
 * depth count nonsense. The final, half-written object has no matching brace
 * and is simply never emitted.
 *
 * Returns raw values, not validated rules: each still goes through
 * ExtractedRule.safeParse with everything else, so a salvaged rule is held to
 * exactly the same standard as one from a clean reply.
 */
export function recoverTruncatedRules(text: string): unknown[] {
  const key = text.indexOf('"rules"');
  if (key === -1) return [];
  const open = text.indexOf("[", key);
  if (open === -1) return [];

  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }

    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* a complete-looking object that still will not parse is not ours */
        }
        start = -1;
      }
      // depth < 0 means the array closed; nothing useful follows.
      if (depth < 0) break;
    } else if (c === "]" && depth === 0) {
      break;
    }
  }
  return out;
}
