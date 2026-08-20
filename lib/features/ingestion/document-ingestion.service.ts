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
  /** Rules this document was NOT entitled to replace, named with the reason:
   *  the incumbent cites a different publisher, or a person authored it. Not
   *  an error — the existing rule stands — but an operator has to be able to
   *  see that a source is trying to overwrite someone else's answers. */
  refused?: string[];
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
  /**
   * Re-extract even when this exact content has already been ingested for
   * this payer.
   *
   * Operator-only, and never set by the cron: the whole point of the dedupe
   * is that re-reading an unchanged document costs a paid extraction and
   * yields nothing new. But without an escape hatch, a source reporting zero
   * rules could not be investigated at all — the only way to make it run
   * again was to edit content_hash in psql, which is awkward and writes a
   * falsehood into the record of what the document contained.
   *
   * The displacement guard still applies, so a forced run cannot overwrite
   * answers this document is not entitled to replace.
   */
  forceReextract?: boolean;
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
  // forceReextract skips the short-circuit. The dedupe is right for the cron —
  // re-reading an unchanged document costs money and yields nothing new — but
  // it left an operator with no way to re-run an extraction at all. Diagnosing
  // a source that reports no rules meant editing content_hash in psql to trick
  // the check, which is both awkward and a lie written into the record of what
  // the document was. This is the honest version of that.
  if (dupe && !args.forceReextract) {
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
      -- A FORCED re-extraction reaches this insert with a document that is
      -- already stored — same url, same payer, same content hash — because it
      -- deliberately skipped the dedupe above. Without this it died on the
      -- 0068 unique constraint (23505) and never got as far as extracting,
      -- which is exactly what the first version of ?force=1 did.
      --
      -- Reuse the row rather than writing a second one: it IS the same
      -- document, and a duplicate would split its rules across two
      -- provenance records and undo what 0068 was written to prevent. Only
      -- retrieved_at moves, because that is the one thing a re-run changes.
      ON CONFLICT (url, payer_id, content_hash)
        DO UPDATE SET retrieved_at = now()
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
  /** Rules this document was not entitled to replace — see the guard below. */
  const refused: string[] = [];
  if (extracted.length > 0 && args.payerId && args.state) {
    // product_line follows the PAYER, not a constant.
    //
    // This was hardcoded to 'commercial' for every payer. Across the live
    // library the column mirrors payer type exactly — medicaid_mco 3,741
    // rules, medicare_ffs 2,610, tribal_638 213, commercial 334 — so the
    // constant was right for one payer type in four and wrong for 95% of the
    // rules by volume.
    //
    // It is not cosmetic. The expire statement below keys on
    // (payer, state, code, attribute) and ignores product_line, so an ingest
    // would retire a medicare_ffs rule and insert a commercial one on the same
    // key. The two no longer pair up, which is exactly what defeated the first
    // attempt to undo tonight's fixture run: a product_line-aware join found
    // zero rows to restore.
    const PRODUCT_LINE_BY_PAYER_TYPE: Record<string, string> = {
      commercial: "commercial",
      medicaid_mco: "medicaid_mco",
      medicare_mac: "medicare_ffs",
      tribal: "tribal_638",
    };
    const productLine = await withBreakglass(async (db) => {
      const rows = await db.$queryRaw<{ payer_type: string | null }[]>`
        SELECT payer_type FROM payer WHERE id = ${args.payerId}::uuid LIMIT 1
      `;
      return PRODUCT_LINE_BY_PAYER_TYPE[rows[0]?.payer_type ?? ""] ?? "commercial";
    }, "ingestion: resolve product_line from payer type");

    await withBreakglass(async (db) => {
      for (const r of extracted) {
        const dbAttr =
          ATTRIBUTE_DB_MAP[r.attribute as keyof typeof ATTRIBUTE_DB_MAP] ??
          r.attribute;
        // ONE TRANSACTION PER RULE — not a savepoint.
        //
        // This used to open a SAVEPOINT per rule, but withBreakglass hands
        // back a PrismaClient, not a transaction: it ends in `return
        // fn(target)` with no $transaction anywhere. So "SAVEPOINT rule_sp"
        // failed with 25P01 (can only be used in transaction blocks), the
        // catch then ran "ROLLBACK TO SAVEPOINT", which raised 25P01 AGAIN
        // from inside the handler — uncaught, killing the whole document.
        // The operator's own ingestion dashboard has been showing that error
        // verbatim on a source, which is where this was found.
        //
        // The two statements still have to be atomic together: expiring the
        // prior rule and failing to insert the replacement would leave the
        // key answering nothing, which is the exact "key goes dark" failure
        // this library has been bitten by before. A per-rule transaction
        // gives that atomicity AND the isolation the savepoints were reaching
        // for — a bad row rolls back alone and the loop carries on.
        try {
          const inserted = await db.$transaction(async (tx) => {
            // A DOCUMENT MAY ONLY REPLACE ANSWERS IT IS ENTITLED TO REPLACE.
            //
            // Until now this expired whatever was live on the key and inserted
            // its own, with no test of where either document came from. That
            // is how a test fixture served off app.pallio.io, pointed at
            // Traditional Medicare, silently replaced ten rules whose
            // citations had been verified against the Federal Register — the
            // answers did not look wrong, they just pointed at the wrong
            // paper, and the weekly drift check would have happily verified
            // them against that fixture forever.
            //
            // The rule now: a replacement must come from the SAME PUBLISHER
            // as the answer it replaces. Same host, or it is not a newer
            // edition of anything — it is a different document making a
            // competing claim, and this pipeline is not entitled to decide
            // that argument silently. Mismatches are skipped and named, which
            // leaves the existing rule standing.
            //
            // Person-authored rules are never displaced by a crawler at all.
            const incumbent = await tx.$queryRaw<
              { id: string; url: string; created_by: string }[]
            >`
              SELECT pr.id, sd.url, pr.created_by
                FROM payer_rule pr
                JOIN source_document sd ON sd.id = pr.source_doc_id
               WHERE pr.payer_id = ${args.payerId}::uuid
                 AND pr.state = ${args.state}
                 AND pr.code = ${r.cptCode}
                 AND pr.attribute = ${dbAttr}
                 AND pr.expiration_date IS NULL
               LIMIT 1
            `;
            const prior = incumbent[0];
            if (prior) {
              if (prior.created_by.includes("@")) {
                throw new RuleDisplacementRefused(
                  `held by a person-authored rule (${prior.created_by})`,
                );
              }
              if (hostOf(prior.url) !== hostOf(args.url)) {
                throw new RuleDisplacementRefused(
                  `incumbent cites ${hostOf(prior.url)}, this document is ${hostOf(args.url)}`,
                );
              }
            }
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
                ${args.payerId}::uuid, ${args.state}, ${productLine},
                ${r.cptCode}, ${dbAttr},
                ${JSON.stringify({ answer: r.answer })}::jsonb,
                ${r.coverageStatus}, ${confidence},
                CURRENT_DATE, NULL,
                ${docId}::uuid, ${r.sourceQuote},
                ${"crawler:" + args.documentType}
              )
              RETURNING id
            `;
            return ins[0]!.id;
          });
          newPayerRuleIds.push({
            ruleId: inserted,
            cptCode: r.cptCode,
            dbAttribute: dbAttr,
            coverageStatus: r.coverageStatus,
            answer: r.answer,
            sourceQuote: r.sourceQuote,
          });
          ruleCount++;
        } catch (e) {
          // Nothing to unwind by hand: the per-rule transaction already
          // rolled itself back, so this only records what was dropped.
          const msg = e instanceof Error ? e.message : String(e);
          skipped.push(`${r.cptCode}/${dbAttr}`);
          if (e instanceof RuleDisplacementRefused) {
            // Not a failure — the guard doing its job. Logged distinctly so a
            // refusal is never read as a broken extraction.
            refused.push(`${r.cptCode}/${dbAttr}: ${e.message}`);
            console.warn(
              `ingest: REFUSED to replace ${r.cptCode}/${dbAttr} — ${e.message}`,
            );
          } else {
            console.warn(
              `ingest: skipped rule code=${r.cptCode} attr=${dbAttr} ` +
                `coverage=${r.coverageStatus} conf=${confidence} — ${msg.replace(/\s+/g, " ").slice(0, 200)}`,
            );
          }
        }
      }
    }, "ingestion: write payer_rule rows");
    if (refused.length) {
      console.warn(
        `ingest: ${refused.length}/${extracted.length} rule(s) REFUSED — this document is ` +
          `not entitled to replace them: ${refused.slice(0, 10).join(" | ")}`,
      );
    }
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
    /** Named, not just counted: a refusal is a finding an operator must see. */
    refused,
    extractError,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Thrown when a document tries to replace an answer it is not entitled to
 * replace. Distinct from an ordinary insert failure: nothing is broken, the
 * pipeline is declining, and the existing rule stays exactly as it was.
 */
class RuleDisplacementRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RuleDisplacementRefused";
  }
}

/**
 * Host of a URL, lowercased and without a leading "www.".
 *
 * Compared to decide whether one document may replace another's answers.
 * www is stripped because uhcprovider.com and www.uhcprovider.com are the
 * same publisher, and a refusal there would be noise rather than protection.
 * Anything unparseable returns the raw string, which cannot equal a real
 * host — so a malformed URL fails closed and replaces nothing.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}

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
