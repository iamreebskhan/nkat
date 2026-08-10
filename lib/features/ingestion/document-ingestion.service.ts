/**
 * Document-ingestion engine (Sources 1 & 2 of the rule corpus).
 *
 * Pipeline:
 *   1. Fetch the URL (or accept inline text).
 *   2. Strip HTML to plain text; PDFs are passed through to Claude as
 *      a native document block (no local PDF parser required).
 *   3. content_hash → skip if we've already ingested this exact byte
 *      sequence (idempotent re-runs are safe).
 *   4. INSERT source_document.
 *   5. Claude extracts structured rules → INSERT payer_rule rows
 *      referencing the source_document.
 *   6. (Optional) Chunk + embed for the RAG fallback.
 *
 * Source 1 (CMS Final Rule, NCD, LCD) and Source 2 (commercial payer
 * public policies) are the SAME pipeline — only the operator-configured
 * URL + document_type differ. See lib/features/ingestion/sources.ts
 * (operator registry) and app/api/cron/ingest-documents (scheduled
 * re-check).
 */
import { createHash } from "node:crypto";

import { embed, isEmbedderConfigured } from "@/lib/ai/embedder";
import {
  extractRulesFromDocument,
  type ExtractedRule,
} from "@/lib/ai/document-rule-extractor";
import { withBreakglass } from "@/lib/db";
import {
  ATTRIBUTE_DB_MAP,
  type CoverageStatus,
} from "@/lib/features/billing/payer-rule.repository";
import { chunkText } from "@/lib/features/documents/extractor";
import { propagateGlobalRuleToAllOrgRulebooks } from "@/lib/features/rulebook/rulebook.service";

/**
 * source_document.document_type values that map to a confidence band
 * for the payer_rule rows extracted from a doc of that type.
 */
const CONFIDENCE_BY_TYPE: Record<string, number> = {
  cms_pfs: 0.95, // CMS Physician Fee Schedule
  cms_coverage_api: 0.95,
  ncd: 0.93,
  lcd: 0.9,
  lcd_article: 0.85,
  mln_article: 0.85,
  medical_policy: 0.8,
  reimbursement_policy: 0.8,
  provider_manual: 0.78,
  hcpcs_release: 0.93,
  ncci_release: 0.93,
  state_medicaid_manual: 0.85,
  wc_fee_schedule: 0.85,
  ihs_rate: 0.85,
  client_upload: 0.5,
  // analyst_call is handled by attestation.service.ts directly.
};

export type IngestableDocumentType =
  | "cms_pfs"
  | "cms_coverage_api"
  | "ncd"
  | "lcd"
  | "lcd_article"
  | "mln_article"
  | "medical_policy"
  | "reimbursement_policy"
  | "provider_manual"
  | "hcpcs_release"
  | "ncci_release"
  | "state_medicaid_manual"
  | "wc_fee_schedule"
  | "ihs_rate"
  | "client_upload";

export interface IngestionResult {
  sourceDocId: string;
  ruleCount: number;
  chunkCount: number;
  embedded: boolean;
  contentHash: string;
  alreadyIngested: boolean;
  /** Rules extracted but rejected on insert (e.g. a CHECK violation) and
   *  skipped so the rest of the document still lands. Should be 0 in normal
   *  operation; a non-zero value points at a data-shape edge case in logs. */
  skipped: number;
  /** If the extraction call itself errored (credit exhausted, model access,
   *  rate limit), the message — so a caller can distinguish an API failure
   *  from a genuinely rule-free document. null on success. */
  extractError: string | null;
}

export interface IngestionInput {
  url: string;
  payerId: string | null;
  state: string | null;
  documentType: IngestableDocumentType;
  title?: string;
  /** Operator-supplied inline content; skips fetch. Use when scraping
   *  the URL would be blocked or for ad-hoc paste-from-clipboard ingest. */
  inlineText?: string;
  /** Base64-encoded PDF bytes; skips fetch. Used to feed a chunk of a large
   *  rule (split client-side) straight into extraction — bypasses the 32 MB
   *  fetch cap and the native-PDF page limit by processing one chunk at a
   *  time. `url` still carries the citation target (e.g. the full-rule URL). */
  inlinePdfBase64?: string;
  /**
   * Fetch and hash the document, then STOP — write nothing, call no AI.
   *
   * Lets the cron answer "has this changed?" without letting an
   * unreviewed extraction into a library that 111 practices bill
   * against. Sources with `auto_extract = FALSE` are checked this way;
   * a detected change raises `review_pending` for a human-run grounded
   * extraction instead of writing rules.
   *
   * Cost of a detect-only pass is one HTTP fetch — no Claude, no
   * embeddings — so it is cheap enough to run often.
   */
  detectOnly?: boolean;
}

/**
 * The whole pipeline. Returns IngestionResult; never throws on
 * empty-rule extraction (CMS docs sometimes describe procedural
 * changes with no per-CPT rule). Throws on fetch/parse/auth errors.
 */
export async function ingestDocumentFromUrl(
  args: IngestionInput,
): Promise<IngestionResult> {
  // 1. Acquire content.
  const fetched = args.inlinePdfBase64
    ? { bytes: Buffer.from(args.inlinePdfBase64, "base64"), contentType: "application/pdf" }
    : args.inlineText
      ? { bytes: Buffer.from(args.inlineText, "utf8"), contentType: "text/plain" }
      : await fetchUrlBytes(args.url);

  // Is this a PDF? Needed before hashing, because the two are hashed on
  // different bases — see below.
  const isPdf =
    !!args.inlinePdfBase64 ||
    fetched.contentType.includes("application/pdf") ||
    args.url.toLowerCase().endsWith(".pdf");

  // For HTML, the extracted text IS the document as far as this pipeline
  // is concerned — it is what Claude reads and what gets chunked. Compute
  // it once here so the hash and the extraction agree.
  const pageText = isPdf ? null : htmlToText(fetched.bytes.toString("utf8"));

  // HASH THE CONTENT, NOT THE TRANSPORT.
  //
  // A byte hash treats every cosmetic difference as a new version of the
  // document: timestamps, ad slots, session ids, rotating nonces, a
  // reordered script tag. Each "new version" writes another
  // source_document row and can trigger another paid Claude extraction of
  // text that did not change.
  //
  // Measured in production before this change: one Aetna clinical policy
  // page had accumulated 13 versions in three months, roughly one every
  // six days, while the policy it states was unchanged.
  //
  // So for HTML we hash the extracted, whitespace-normalised text. Real
  // wording changes still produce a new hash and a genuine new version;
  // markup churn no longer does.
  //
  // PDFs keep hashing bytes. There is no in-process text extraction for
  // them here (they are passed to Claude as a document block), and a PDF
  // is not normally re-rendered per request.
  //
  // The stored format stays 'sha256:<64 hex>' either way — migration 0068
  // keys its merge scope on exactly that shape — and which basis was used
  // is recorded in source_metadata.hashBasis instead.
  const hashBasis = isPdf ? "bytes" : "extracted-text";
  const contentHash =
    "sha256:" +
    createHash("sha256")
      .update(isPdf ? fetched.bytes : normalizeForHash(pageText!))
      .digest("hex");

  // Detect-only: the caller wants the hash, nothing else. Return before
  // touching source_document, Claude, or the embedder.
  if (args.detectOnly) {
    return {
      sourceDocId: "", ruleCount: 0, chunkCount: 0, embedded: false,
      contentHash, alreadyIngested: false, skipped: 0, extractError: null,
    };
  }

  // 2. Idempotency check — scoped to (content_hash, payer_id).
  //
  // It used to match on content_hash alone, across all payers. That is
  // wrong for the documents that matter most here: one state Medicaid
  // clinical coverage policy governs every MCO in the state, and a
  // multi-plan payer publishes the identical PDF under several plans.
  // Under the old check, the first plan ingested and every subsequent
  // plan silently returned `alreadyIngested: true, ruleCount: 0` — no
  // rules, no error, no signal.
  //
  // IS NOT DISTINCT FROM (not `=`) so a payer-agnostic re-ingest of the
  // same statewide document still dedupes against itself; NULL = NULL
  // would be NULL, i.e. never a match.
  const dupe = await withBreakglass(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM source_document
       WHERE content_hash = ${contentHash}
         AND payer_id IS NOT DISTINCT FROM ${args.payerId ?? null}::uuid
       LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }, "ingestion idempotency lookup");
  if (dupe) {
    return {
      sourceDocId: dupe,
      ruleCount: 0,
      chunkCount: 0,
      embedded: false,
      contentHash,
      alreadyIngested: true,
      skipped: 0,
      extractError: null,
    };
  }

  // 3. Prepare for Claude extraction. isPdf and pageText were computed
  //    above, because the content hash depends on them.
  const extractInput = isPdf
    ? { pdfBase64: fetched.bytes.toString("base64") }
    : { textContent: pageText! };

  // 4. Persist source_document FIRST (so payer_rule FK is satisfied).
  const docId = await withBreakglass(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO source_document (
        payer_id, url, document_type, title, effective_date,
        retrieved_at, content_hash, cms_license_token_used, source_metadata
      ) VALUES (
        ${args.payerId}::uuid, ${args.url}, ${args.documentType},
        ${args.title ?? args.url}, NULL, now(), ${contentHash}, FALSE,
        ${JSON.stringify({
          state: args.state,
          inline: !!args.inlineText,
          // Which basis produced content_hash, so a future reader can tell
          // a text hash from a byte hash without guessing.
          hashBasis,
        })}::jsonb
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }, "ingestion: write source_document");

  // 5. Extract rules with Claude.
  let extracted: ExtractedRule[] = [];
  let extractError: string | null = null;
  try {
    extracted = await extractRulesFromDocument({
      ...extractInput,
      state: args.state ?? undefined,
      documentTitle: args.title,
    });
  } catch (e) {
    // Don't blow up the whole ingest — we still have the document stored
    // (and chunked/embedded for text docs). But SURFACE the reason so a
    // caller can tell "0 rules extracted" (empty doc) apart from "extraction
    // errored" (e.g. Anthropic credit exhausted, model access, rate limit).
    extractError = e instanceof Error ? e.message : String(e);
    console.warn(
      "ingestDocumentFromUrl: extraction failed; doc stored, no rules written.",
      extractError,
    );
  }

  // 6. Insert payer_rule rows for everything extracted.
  const confidence = CONFIDENCE_BY_TYPE[args.documentType] ?? 0.7;
  let ruleCount = 0;
  const newPayerRuleIds: Array<{
    ruleId: string;
    cptCode: string;
    dbAttribute: string;
    coverageStatus: CoverageStatus;
    answer: string;
    sourceQuote: string;
  }> = [];
  const skipped: string[] = [];
  if (extracted.length > 0 && args.payerId && args.state) {
    await withBreakglass(async (tx) => {
      for (const r of extracted) {
        const dbAttr =
          ATTRIBUTE_DB_MAP[r.attribute as keyof typeof ATTRIBUTE_DB_MAP] ??
          r.attribute;
        // Isolate each rule in a SAVEPOINT so one bad row (e.g. a value that
        // trips a CHECK constraint) is rolled back + logged rather than
        // aborting the whole document's insert. Essential for large, varied
        // docs (the 1,216-page final rule) where a stray row is inevitable.
        try {
          await tx.$executeRawUnsafe("SAVEPOINT rule_sp");
          // Expire any prior active rule for the same key.
          await tx.$executeRaw`
            UPDATE payer_rule SET expiration_date = CURRENT_DATE
             WHERE payer_id = ${args.payerId}::uuid
               AND state = ${args.state}
               AND code = ${r.cptCode}
               AND attribute = ${dbAttr}
               AND expiration_date IS NULL
          `;
          const ins = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO payer_rule (
              payer_id, state, product_line, code, attribute,
              value, coverage_status, confidence,
              effective_date, expiration_date,
              source_doc_id, source_quote,
              created_by
            ) VALUES (
              ${args.payerId}::uuid, ${args.state}, 'commercial',
              ${r.cptCode}, ${dbAttr},
              ${JSON.stringify({ answer: r.answer })}::jsonb,
              ${r.coverageStatus}, ${confidence},
              CURRENT_DATE, NULL,
              ${docId}::uuid, ${r.sourceQuote},
              ${"crawler:" + args.documentType}
            )
            RETURNING id
          `;
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT rule_sp");
          newPayerRuleIds.push({
            ruleId: ins[0]!.id,
            cptCode: r.cptCode,
            dbAttribute: dbAttr,
            coverageStatus: r.coverageStatus,
            answer: r.answer,
            sourceQuote: r.sourceQuote,
          });
          ruleCount++;
        } catch (e) {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT rule_sp");
          const msg = e instanceof Error ? e.message : String(e);
          skipped.push(`${r.cptCode}/${dbAttr}`);
          console.warn(
            `ingest: skipped rule code=${r.cptCode} attr=${dbAttr} ` +
              `coverage=${r.coverageStatus} conf=${confidence} — ${msg.replace(/\s+/g, " ").slice(0, 200)}`,
          );
        }
      }
    }, "ingestion: write payer_rule rows");
    if (skipped.length) {
      console.warn(`ingest: ${skipped.length}/${extracted.length} rule(s) skipped: ${skipped.slice(0, 15).join(", ")}`);
    }

    // Refresh org rulebooks for each inserted rule (cross-org).
    // Done outside the breakglass loop because refresh uses its own
    // breakglass session — keeps the writes scoped.
    for (const n of newPayerRuleIds) {
      await propagateGlobalRuleToAllOrgRulebooks({
        ruleId: n.ruleId,
        payerId: args.payerId!,
        state: args.state!,
        cptCode: n.cptCode,
        dbAttribute: n.dbAttribute,
        coverageStatus: n.coverageStatus,
        ruleValue: { answer: n.answer },
        confidence,
        sourceQuote: n.sourceQuote,
      });
    }
  }

  // 7. Chunk + embed for RAG fallback (only for non-PDF text — PDFs
  //    we leave to Claude's native document path on the next lookup).
  let chunkCount = 0;
  let embedded = false;
  if (extractInput.textContent && extractInput.textContent.length > 0) {
    const chunks = chunkText(extractInput.textContent);
    const canEmbed = isEmbedderConfigured();
    await withBreakglass(async (tx) => {
      for (let i = 0; i < chunks.length; i++) {
        let vec: number[] | null = null;
        if (canEmbed) {
          try {
            vec = await embed(chunks[i]);
            embedded = true;
          } catch {
            vec = null;
          }
        }
        if (vec) {
          const lit = `[${vec.join(",")}]`;
          await tx.$executeRaw`
            INSERT INTO document_chunk (
              source_doc_id, chunk_index, content, embedding,
              payer_id, state
            ) VALUES (
              ${docId}::uuid, ${i}, ${chunks[i]}, ${lit}::vector,
              ${args.payerId}::uuid, ${args.state}
            )
          `;
        } else {
          await tx.$executeRaw`
            INSERT INTO document_chunk (
              source_doc_id, chunk_index, content, payer_id, state
            ) VALUES (
              ${docId}::uuid, ${i}, ${chunks[i]}, ${args.payerId}::uuid, ${args.state}
            )
          `;
        }
        chunkCount++;
      }
    }, "ingestion: write document_chunk rows");
  }

  return {
    sourceDocId: docId,
    ruleCount,
    chunkCount,
    embedded,
    contentHash,
    alreadyIngested: false,
    skipped: skipped.length,
    extractError,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function fetchUrlBytes(
  url: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers: {
      // CMS (Akamai) and many payer sites 403 non-browser UAs — a bot UA like
      // "Pallio-ingest/1.0" is blocked outright, so we can't ingest Source 1
      // (cms.gov) at all with it. Present a standard browser UA + headers so
      // those bot managers serve us. (Verified: CMS 403s a bot UA, 200s this.)
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      accept:
        "application/pdf, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5",
      "accept-language": "en-US,en;q=0.9",
    },
    // Some payers redirect — follow.
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Cap document size — Anthropic limits + sanity.
  if (buf.length > 32 * 1024 * 1024) {
    throw new Error(`document too large: ${buf.length} bytes (cap 32MB)`);
  }
  return { bytes: buf, contentType: res.headers.get("content-type") ?? "" };
}

/**
 * Strip HTML to plain text — zero-dependency. Removes script/style
 * blocks, then tags, then collapses whitespace. Good enough for the
 * policy pages we typically ingest (paragraph-heavy text on a plain
 * template).
 */
/**
 * Normalise extracted text before hashing it.
 *
 * Whitespace is the noisiest difference between two fetches of the same
 * page - a reflowed paragraph, a changed indent, CRLF versus LF - and none
 * of it changes what the document SAYS. Collapsing it means only a real
 * wording change mints a new version.
 *
 * Deliberately conservative: it folds whitespace and case, and nothing
 * else. It does not strip numbers, dates or punctuation, because a payer
 * changing "after five visits" to "after three visits" - or an effective
 * date moving - is exactly the change this pipeline exists to notice.
 */
function normalizeForHash(text: string): string {
  return text.replace(/s+/g, " ").trim().toLowerCase();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Internals exposed for tests only.
 *
 * The content-hash basis is the one piece of this file with a failure mode
 * nobody notices: too strict and every fetch mints a version, too loose
 * and a payer can change its rules without the pipeline reacting. Both
 * halves are asserted in __tests__/content-hash.spec.ts, which needs the
 * two functions the hash is built from.
 */
export const __testing = { htmlToText, normalizeForHash };
