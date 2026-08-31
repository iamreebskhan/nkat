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
import { ValidationError } from "@/lib/api";
import { withBreakglass } from "@/lib/db";
import {
  ATTRIBUTE_DB_MAP,
  type CoverageStatus,
} from "@/lib/features/billing/payer-rule.repository";
import { chunkText } from "@/lib/features/documents/extractor";
import { fetchRenderedText } from "@/lib/features/documents/browser-fetch";
import { extractPdfText } from "@/lib/features/documents/pdf-text";
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
  /** The title the fetched page gives ITSELF, so an operator running a source
   *  by hand can see immediately whether it still serves the document they
   *  think it does. null for PDFs and for inline content. */
  fetchedTitle?: string | null;
  /** Present only for dryRun. What a real run would have done. */
  plan?: IngestionPlan;
}

/**
 * What a real run would do, worked out without doing it.
 *
 * `wouldDisplace` is the row that matters: every one of those is a live rule
 * that would stop answering, named with who wrote it, so "will this overwrite
 * my seeded Medicare rules?" has an answer before the button is pressed
 * rather than after.
 */
export interface IngestionPlan {
  extracted: number;
  /** Keys with no live rule — these would be pure additions. */
  wouldAdd: { code: string; attribute: string }[];
  /** Live rules that would be expired and replaced. */
  wouldDisplace: {
    code: string;
    attribute: string;
    incumbentCreatedBy: string;
    incumbentUrl: string;
  }[];
  /** Keys the guard would protect, with the reason it refuses. */
  wouldRefuse: { code: string; attribute: string; reason: string }[];
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
   * Do everything a real run does — fetch, screen, extract with Claude —
   * and then write NOTHING. Report what would have happened instead.
   *
   * detectOnly answers "has this changed?". This answers the question that
   * actually stops an operator from pressing the button: "what would this do
   * to the library?" Registering a source pointed at the wrong document is
   * how ten FR-cited Medicare rules were displaced once already, and the
   * displacement guard cannot save you when the wrong document is on the
   * right host — same publisher, so replacement is allowed.
   *
   * Costs one extraction, which is the point: the answer is only worth
   * anything if the rules are the real ones Claude would write.
   */
  dryRun?: boolean;
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
  const rawHtml = isPdf ? null : fetched.bytes.toString("utf8");
  let pageText = rawHtml === null ? null : htmlToText(rawHtml);
  // Filled in below for PDFs, once the file is parsed for PHI screening.
  let pdfTitle: string | null = null;
  // Set when the page only existed after JavaScript ran.
  let renderedTitle: string | null = null;

  // A page that strips to almost nothing may be a dead URL — or a page that
  // is assembled client-side. Anthem's provider-news articles return 44 KB of
  // HTML that reduces to the thirteen characters "Provider News"; the article
  // is built by script and a plain fetch never sees it. Rather than refuse a
  // source that a browser can read perfectly well, render it once and look
  // again.
  //
  // Only on this path. Every other source in the library arrives fine from a
  // plain fetch, and rendering them all would be slower and no more correct.
  // Skipped for inline content, which is whatever the caller handed us.
  if (
    pageText !== null &&
    !args.inlineText &&
    pageText.length < MIN_DOCUMENT_TEXT
  ) {
    const rendered = await fetchRenderedText(args.url);
    if (rendered.ok && rendered.text.length > pageText.length) {
      console.warn(
        `ingest: ${args.url} needed a browser — ${fetched.bytes.length} bytes ` +
          `stripped to ${pageText.length} chars, rendered to ${rendered.text.length}`,
      );
      pageText = rendered.text;
      renderedTitle = rendered.title;
    } else if (!rendered.ok) {
      console.warn(`ingest: browser render failed for ${args.url} — ${rendered.reason}`);
    }
  }

  // A page that rendered almost nothing is not a document. Inline content is
  // exempt — that is what the caller meant to send.
  if (pageText !== null && !args.inlineText) {
    assertReadableDocument(pageText, args.url, fetched.bytes.length);
  }
  // What the document calls itself, recorded next to what we called it.
  // For HTML that is the <title>; for a PDF it is resolved below from the
  // same parse the PHI screen needs, so both kinds of source can now
  // contradict their own configuration. That matters because 25 of the 28
  // registered sources are PDFs — a check that only reads HTML titles is
  // blind exactly where nearly every source lives.
  // A rendered page's <title> beats the shell's: on a JavaScript-only article
  // the served HTML titles itself with the site name ("Provider News") and
  // only the rendered document knows what the article is called.
  const htmlTitle =
    renderedTitle ?? (rawHtml === null ? null : htmlDocumentTitle(rawHtml));

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
      // htmlTitle, not the resolved one: detect-only returns before the PDF
      // is parsed, and parsing a PDF purely to name it is not what this
      // caller asked for.
      fetchedTitle: htmlTitle,
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
  // A dry run bypasses it for the same reason force does: the whole point is
  // to see what this document would produce, and "nothing, it is unchanged"
  // is not an answer to that question.
  if (dupe && !args.forceReextract && !args.dryRun) {
    return {
      sourceDocId: dupe,
      ruleCount: 0,
      chunkCount: 0,
      embedded: false,
      contentHash,
      alreadyIngested: true,
      skipped: 0,
      extractError: null,
      // Reported even on the dedupe path: an operator pressing "Run now" on an
      // unchanged source is usually doing it to find out what is there. Null
      // for a PDF, which is not parsed on this path — ?force=1 reads it.
      fetchedTitle: htmlTitle,
    };
  }

  // 3. Prepare for Claude extraction. isPdf and pageText were computed
  //    above, because the content hash depends on them.
  //
  //    For a PDF this is also where its text layer is read — not to send
  //    (Claude gets the PDF itself, which it reads better) but so the PHI
  //    guard has something to screen. Until now it had nothing: the guard
  //    ran on textContent only, so the ~20 of 25 sources that are PDFs went
  //    to Anthropic unread. Deliberately AFTER the dedupe short-circuit, so
  //    an unchanged document costs nothing.
  let extractInput: { textContent: string } | { pdfBase64: string; pdfText: string };
  if (isPdf) {
    const pdf = await extractPdfText(fetched.bytes);
    assertScreenablePdf(pdf, args.url, fetched.bytes.length);
    pdfTitle = pdf.title;
    extractInput = { pdfBase64: fetched.bytes.toString("base64"), pdfText: pdf.text };
  } else {
    extractInput = { textContent: pageText! };
  }

  // 3b. Dry run: extract for real, write nothing, report what a real run
  //     would have done. Placed BEFORE the source_document insert, because
  //     "writes nothing" has to mean nothing — a dry run that leaves a
  //     provenance row behind is a real run with a smaller blast radius.
  if (args.dryRun) {
    return planOnly({
      extractInput,
      args,
      contentHash,
      fetchedTitle: htmlTitle ?? pdfTitle,
    });
  }

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
          // The document's own title — <title> for HTML, the Info /Title or
          // opening line for a PDF. See htmlDocumentTitle / extractPdfText.
          fetchedTitle: htmlTitle ?? pdfTitle,
          // Set only when the payer's own host would not answer and the bytes
          // came from an archive. An archived copy lags the live document, so
          // this must travel with the provenance rather than being forgotten
          // the moment the fetch succeeded.
          readVia: fetched.readVia ?? null,
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
      --
      -- Merge the metadata rather than leaving it: a re-read is the moment a
      -- renumbered document announces itself, and the stored fetchedTitle
      -- has to be able to change when the page does.
      ON CONFLICT (url, payer_id, content_hash)
        DO UPDATE SET retrieved_at    = now(),
                      source_metadata = source_document.source_metadata
                                        || excluded.source_metadata
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
            const refusal = displacementRefusal(incumbent[0] ?? null, args.url);
            if (refusal) throw new RuleDisplacementRefused(refusal);
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
  //    pageText, not extractInput: the PDF branch now also carries text, but
  //    it is a screening copy of the text LAYER and must not become the
  //    chunks a lookup cites. Claude reads the PDF itself.
  if (pageText && pageText.length > 0) {
    const chunks = chunkText(pageText);
    const canEmbed = isEmbedderConfigured();
    await withBreakglass(async (tx) => {
      // A FORCED re-extraction reaches here with chunks already stored against
      // this document, and (source_doc_id, chunk_index) is unique — so the
      // insert below failed with 23505 and took the whole run down after the
      // rules had been extracted. Clear the old chunks first.
      //
      // Delete rather than upsert: re-chunking the same text can produce a
      // DIFFERENT number of chunks, and upserting by index would leave the
      // tail of a previous, longer run orphaned behind the new one — stale
      // text still answering RAG lookups. Replacing the set is the only way
      // the chunks stay a faithful copy of the document.
      if (args.forceReextract) {
        await tx.$executeRaw`
          DELETE FROM document_chunk WHERE source_doc_id = ${docId}::uuid
        `;
      }
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
    fetchedTitle: htmlTitle ?? pdfTitle,
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
/**
 * The dry-run path: extract for real, then look up — read-only — what each
 * extracted rule would land on.
 *
 * Shares displacementRefusal() with the write path deliberately. A dry run
 * that reimplements the guard would eventually disagree with it, and a report
 * that is confidently wrong about whether your seeded rules survive is worse
 * than no report at all.
 */
async function planOnly(ctx: {
  extractInput: { textContent: string } | { pdfBase64: string; pdfText: string };
  args: IngestionInput;
  contentHash: string;
  fetchedTitle: string | null;
}): Promise<IngestionResult> {
  const { args, contentHash, fetchedTitle } = ctx;

  let extracted: ExtractedRule[] = [];
  let extractError: string | null = null;
  try {
    extracted = await extractRulesFromDocument({
      ...ctx.extractInput,
      state: args.state ?? undefined,
      documentTitle: args.title,
    });
  } catch (e) {
    extractError = e instanceof Error ? e.message : String(e);
  }

  const plan: IngestionPlan = {
    extracted: extracted.length,
    wouldAdd: [],
    wouldDisplace: [],
    wouldRefuse: [],
  };

  if (args.payerId && args.state) {
    await withBreakglass(async (tx) => {
      for (const r of extracted) {
        const dbAttr =
          ATTRIBUTE_DB_MAP[r.attribute as keyof typeof ATTRIBUTE_DB_MAP] ?? r.attribute;
        const rows = await tx.$queryRaw<{ url: string; created_by: string }[]>`
          SELECT sd.url, pr.created_by
            FROM payer_rule pr
            JOIN source_document sd ON sd.id = pr.source_doc_id
           WHERE pr.payer_id = ${args.payerId}::uuid
             AND pr.state = ${args.state}
             AND pr.code = ${r.cptCode}
             AND pr.attribute = ${dbAttr}
             AND pr.expiration_date IS NULL
           LIMIT 1
        `;
        const incumbent = rows[0] ?? null;
        const reason = displacementRefusal(incumbent, args.url);
        if (reason) {
          plan.wouldRefuse.push({ code: r.cptCode, attribute: dbAttr, reason });
        } else if (incumbent) {
          plan.wouldDisplace.push({
            code: r.cptCode,
            attribute: dbAttr,
            incumbentCreatedBy: incumbent.created_by,
            incumbentUrl: incumbent.url,
          });
        } else {
          plan.wouldAdd.push({ code: r.cptCode, attribute: dbAttr });
        }
      }
    }, "ingestion dry run: incumbent lookup");
  }

  // Logged, not only returned.
  //
  // A dry run writes nothing by design, so its plan exists solely in the HTTP
  // response — and the runs that matter most are the slow ones. Aetna's
  // telemedicine policy took long enough that Cloudflare returned 504 before
  // the app answered: the extraction ran, the plan was computed, the money
  // was spent, and the answer went nowhere. A line in the log survives the
  // edge giving up on the request.
  console.warn(
    `ingest DRY RUN ${args.url} — extracted=${plan.extracted} ` +
      `add=${plan.wouldAdd.length} displace=${plan.wouldDisplace.length} ` +
      `refuse=${plan.wouldRefuse.length}` +
      (extractError ? ` extractError=${extractError}` : "") +
      (plan.wouldDisplace.length
        ? `\n  would displace: ${plan.wouldDisplace
            .map((d) => `${d.code}/${d.attribute} (${d.incumbentCreatedBy} @ ${hostOf(d.incumbentUrl)})`)
            .join(", ")}`
        : "") +
      (plan.wouldRefuse.length
        ? `\n  would refuse: ${plan.wouldRefuse
            .map((d) => `${d.code}/${d.attribute} — ${d.reason}`)
            .join(", ")}`
        : ""),
  );

  return {
    sourceDocId: "",
    ruleCount: 0,
    chunkCount: 0,
    embedded: false,
    contentHash,
    alreadyIngested: false,
    skipped: 0,
    extractError,
    fetchedTitle,
    plan,
  };
}

/**
 * May this document replace the rule currently answering a key?
 *
 * Returns the reason it may NOT, or null when it may. Pulled out of the write
 * path so a dry run can ask the same question without writing — a dry run
 * that reimplements this would eventually disagree with it, and the moment it
 * did, the report would be worse than no report.
 *
 * The rule: a replacement must come from the SAME PUBLISHER as the answer it
 * replaces. Same host, or it is not a newer edition of anything — it is a
 * different document making a competing claim, and this pipeline is not
 * entitled to decide that argument silently. Person-authored rules are never
 * displaced by a crawler at all.
 */
export function displacementRefusal(
  incumbent: { url: string; created_by: string } | null,
  candidateUrl: string,
): string | null {
  if (!incumbent) return null;
  if (incumbent.created_by.includes("@")) {
    return `held by a person-authored rule (${incumbent.created_by})`;
  }
  if (hostOf(incumbent.url) !== hostOf(candidateUrl)) {
    return `incumbent cites ${hostOf(incumbent.url)}, this document is ${hostOf(candidateUrl)}`;
  }
  return null;
}

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
/**
 * The PUBLISHER a URL belongs to — the registrable domain, not the hostname.
 *
 * This stripped "www." and compared the rest, which made every other
 * subdomain a different publisher. Aetna serves the same office manual from
 * www.aetna.com and es.aetna.com (its Spanish site); 75 live rules cite the
 * latter, so a fresh read of the canonical host was refused with "incumbent
 * cites es.aetna.com, this document is aetna.com" — Aetna forbidden from
 * updating Aetna. Anthem has the same shape: providernews.anthem.com and
 * files.providernews.anthem.com are one publisher on two hosts.
 *
 * The guard exists to stop a DIFFERENT publisher's document quietly
 * overwriting an answer — a test fixture replacing ten Federal Register
 * rules. Subdomains of one organisation are not that. Comparing the last two
 * labels keeps cms.gov, federalregister.gov and govinfo.gov distinct, which
 * is the distinction that was actually paid for.
 *
 * Two labels, not a public-suffix list: every payer and agency in this
 * library sits on .com, .gov or .org, where two labels is exactly right. It
 * would over-merge under a multi-part suffix like .co.uk — worth replacing
 * with a real PSL if a source ever lands on one.
 */
function hostOf(url: string): string {
  try {
    const host = new URL(url).host.toLowerCase();
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
  } catch {
    return url;
  }
}

/**
 * Fetch a document, falling back to the Internet Archive when the payer's own
 * host will not answer us.
 *
 * Medical Mutual of Ohio refuses TCP from every network we have — workstation,
 * VPS and a headless browser alike — so its provider manual is unreachable
 * directly. It is not unreachable in principle: recheck-source-drift.mjs reads
 * that exact manual every week through web.archive.org and confirms all 141
 * rules citing it are still supported. The document is live, official and
 * verifiable; only our route to it is gone.
 *
 * The drift checker has had this fallback since it was written. Ingestion
 * never did, so a payer that blocks us could be CHECKED but never re-read —
 * and Medical Mutual sits at zero registered sources for exactly that reason.
 *
 * Two things this is careful about, both learned by that script:
 *
 *   - The Archive refuses our browser User-Agent. It is requested bare.
 *   - An archived copy LAGS the live document. Reading one is a weaker fact
 *     than reading the original, so `readVia` comes back with the bytes and
 *     is recorded on the document; it is never presented as a direct read.
 */
const ARCHIVE_PREFIX = "https://web.archive.org/web/2/";

async function fetchUrlBytes(
  url: string,
): Promise<{ bytes: Buffer; contentType: string; readVia?: string }> {
  try {
    return await fetchDirect(url);
  } catch (direct) {
    // Only for an origin that would not talk to us at all. A 404 or a 403 is
    // an answer — the source is wrong or blocking deliberately, and an
    // archived copy would paper over that.
    const message = direct instanceof Error ? direct.message : String(direct);
    if (!/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(message)) {
      throw direct;
    }
    const mirror = ARCHIVE_PREFIX + url;
    try {
      const got = await fetchDirect(mirror, { bare: true });
      console.warn(
        `ingest: ${url} did not answer (${message.slice(0, 80)}); read from the ` +
          `Internet Archive instead. This copy lags the live document.`,
      );
      return { ...got, readVia: mirror };
    } catch {
      // Report the ORIGINAL failure. "web.archive.org did not answer" would
      // send the operator to fix the wrong host.
      throw direct;
    }
  }
}

async function fetchDirect(
  url: string,
  opts: { bare?: boolean } = {},
): Promise<{ bytes: Buffer; contentType: string }> {
  if (opts.bare) {
    // No User-Agent at all: the Internet Archive refuses ours.
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`fetch ${url} → ${r.status} ${r.statusText}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > 32 * 1024 * 1024) {
      throw new Error(`document too large: ${b.length} bytes (cap 32MB)`);
    }
    return { bytes: b, contentType: r.headers.get("content-type") ?? "" };
  }
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
  // \s+, not s+. The backslash was missing, so this replaced every literal
  // letter "s" with a space: "skilled nursing services" hashed as
  // "kill ...". Deterministic, so nothing broke loudly, and the tests below
  // it all still passed — none of them compared two texts that differ only
  // in an s. It still meant the hash was taken over a mangled copy of the
  // document, and two versions differing only where an "s" met a space
  // would have collapsed into "unchanged".
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Below this many characters of extracted text, a fetch has not produced a
 * document and must not be treated as one. Same number and same reasoning as
 * MIN_TEXT in scripts/recheck-source-drift.mjs, which already learned this:
 * an empty extraction that is allowed through does not fail, it AGREES with
 * everything, and the agreement is reported as health.
 *
 * The case that prompted it here: Anthem's provider-news article at
 *   providernews.anthem.com/ohio/articles/quick-guide-...-28751
 * returns 44 KB of HTML that renders, after tag stripping, to the thirteen
 * characters "Provider News". It is a JavaScript-only page. The pipeline was
 * willing to hash those thirteen characters as the document, send them to
 * Claude, and file the result as "Last extraction produced no rules — the
 * document may have been restructured". That sentence points the operator at
 * the extractor. The truth is that the page never arrived, and the fix is a
 * different fetch strategy, not a different prompt.
 *
 * It also froze: thirteen characters hash stably, so the source would have
 * gone on reporting "unchanged" forever.
 */
const MIN_DOCUMENT_TEXT = 400;

function assertReadableDocument(text: string, url: string, rawBytes: number): void {
  if (text.length >= MIN_DOCUMENT_TEXT) return;
  // ValidationError, not Error: this is a fact about the document that the
  // operator needs to read. A bare Error reaches handleServiceError as an
  // internal fault and comes back "Something went wrong. Try again or
  // contact support." — which is the opposite of what happened. Nothing went
  // wrong; the document is not usable and the message says exactly why.
  throw new ValidationError(
    `Document did not render: ${url} returned ${rawBytes} bytes that extract ` +
      `to only ${text.length} characters of text (need ${MIN_DOCUMENT_TEXT}). ` +
      `Usually a JavaScript-rendered page or a scanned image. Not an extraction ` +
      `failure — the document never arrived.`,
  );
}

/**
 * A PDF we cannot read is not a PDF we can screen, and an unscreened
 * document does not go to a vendor we have no BAA with.
 *
 * This is a DIFFERENT failure from assertReadableDocument's, and says so.
 * An HTML page with no text never arrived. A PDF with no text arrived fine —
 * it is a scan, and Claude's vision path would read it perfectly well. We
 * just cannot see inside it to check what we would be sending, so we stop.
 * The distinction matters because the two have opposite fixes: one needs a
 * different fetch, the other needs OCR or a human vouching for the source.
 *
 * Measured on six real payer PDFs: 9.8 KB to 331 KB of text, none remotely
 * near the floor. Today this refuses nothing that is in the library.
 */
function assertScreenablePdf(
  pdf: { text: string; pages: number; complete: boolean; reason: string | null },
  url: string,
  rawBytes: number,
): void {
  if (!pdf.complete) {
    throw new ValidationError(
      `PDF could not be screened for PHI: ${url} (${rawBytes} bytes) — ` +
        `${pdf.reason}. A partial read is not a clean scan; the page we did ` +
        `not reach is exactly the one that would matter. Not sent.`,
    );
  }
  if (pdf.text.length < MIN_DOCUMENT_TEXT) {
    throw new ValidationError(
      `PDF could not be screened for PHI: ${url} (${rawBytes} bytes, ` +
        `${pdf.pages} pages) yielded only ${pdf.text.length} characters of ` +
        `text (need ${MIN_DOCUMENT_TEXT}) — it is almost certainly a scan. ` +
        `Claude could read it, but we cannot check what we would be sending, ` +
        `so it is not sent.`,
    );
  }
}

/**
 * The title the DOCUMENT gives itself, as published — not the name we filed
 * it under.
 *
 * source_document.title has always been `args.title ?? args.url`, i.e. our
 * own label echoed back. That makes the record incapable of contradicting
 * us, and a source can therefore point somewhere else entirely without
 * anything on screen looking wrong. It did: an ingestion source registered
 * as "Aetna OH home-visit reimbursement" pointed at CPB 0009, which Aetna
 * has since renumbered to "Orthopedic Casts, Braces and Splints". Nothing
 * in the platform disagreed, because nothing in the platform had ever
 * looked at what the page called itself.
 *
 * Stored alongside the source name so the two can be read together.
 */
function htmlDocumentTitle(html: string): string | null {
  const raw =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (!raw) return null;
  const clean = htmlToText(raw);
  return clean ? clean.slice(0, 300) : null;
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
export const __testing = {
  htmlToText,
  normalizeForHash,
  htmlDocumentTitle,
  assertReadableDocument,
  assertScreenablePdf,
  MIN_DOCUMENT_TEXT,
};
