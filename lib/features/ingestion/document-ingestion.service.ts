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
import { refreshOrgRulebookRowsForRule } from "@/lib/features/rulebook/rulebook.service";

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
  const fetched = args.inlineText
    ? { bytes: Buffer.from(args.inlineText, "utf8"), contentType: "text/plain" }
    : await fetchUrlBytes(args.url);

  const contentHash =
    "sha256:" + createHash("sha256").update(fetched.bytes).digest("hex");

  // 2. Idempotency check.
  const dupe = await withBreakglass(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM source_document WHERE content_hash = ${contentHash} LIMIT 1
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
    };
  }

  // 3. Prepare for Claude extraction.
  const isPdf =
    fetched.contentType.includes("application/pdf") ||
    args.url.toLowerCase().endsWith(".pdf");
  const extractInput = isPdf
    ? { pdfBase64: fetched.bytes.toString("base64") }
    : { textContent: htmlToText(fetched.bytes.toString("utf8")) };

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
        })}::jsonb
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }, "ingestion: write source_document");

  // 5. Extract rules with Claude.
  let extracted: ExtractedRule[] = [];
  try {
    extracted = await extractRulesFromDocument({
      ...extractInput,
      state: args.state ?? undefined,
      documentTitle: args.title,
    });
  } catch (e) {
    // Don't blow up the whole ingest — we still have the document
    // chunked + embedded for the RAG fallback. Log + continue.
    console.warn(
      "ingestDocumentFromUrl: extraction failed; doc stored, no rules written.",
      e,
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
  if (extracted.length > 0 && args.payerId && args.state) {
    await withBreakglass(async (tx) => {
      for (const r of extracted) {
        const dbAttr =
          ATTRIBUTE_DB_MAP[r.attribute as keyof typeof ATTRIBUTE_DB_MAP] ??
          r.attribute;
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
        newPayerRuleIds.push({
          ruleId: ins[0]!.id,
          cptCode: r.cptCode,
          dbAttribute: dbAttr,
          coverageStatus: r.coverageStatus,
          answer: r.answer,
          sourceQuote: r.sourceQuote,
        });
        ruleCount++;
      }
    }, "ingestion: write payer_rule rows");

    // Refresh org rulebooks for each inserted rule (cross-org).
    // Done outside the breakglass loop because refresh uses its own
    // breakglass session — keeps the writes scoped.
    for (const n of newPayerRuleIds) {
      await refreshOrgRulebookRowsForRule({
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
      // Some payer sites block bot UAs; identify Pallio honestly + ask for HTML/PDF.
      "user-agent": "Pallio-ingest/1.0 (+https://app.pallio.io)",
      accept:
        "application/pdf, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5",
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
