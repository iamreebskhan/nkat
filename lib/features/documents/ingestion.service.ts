/**
 * Ingestion service (gap A+C) — turns an uploaded file into either:
 *
 *   • a `rulebook_upload` row with structured `parsed_rows`  (Path B
 *     reconciliation), for CSV rulebooks; or
 *   • a `source_document` + embedded `document_chunk` rows, for
 *     free-text policy docs (powers the vector/RAG fallback).
 *
 * Raw bytes are NOT persisted to disk (avoids VPS fs-perms coupling) —
 * we keep a content hash + the derived structured/chunk data, which is
 * what every downstream consumer actually reads.
 */
import { createHash } from "node:crypto";

import { withBreakglass, withOrgContext } from "@/lib/db";
import { embed, isEmbedderConfigured } from "@/lib/ai/embedder";
import { chunkText, parseRulebookCsv } from "./extractor";

export interface RulebookIngestResult {
  uploadId: string;
  parsedRowCount: number;
  resolvedPayers: number;
  errors: string[];
}

/**
 * Parse a rulebook CSV, resolve payer names/ids, and store a
 * `rulebook_upload` row whose `parsed_rows` feeds buildComparison().
 */
export async function ingestRulebookCsv(args: {
  orgId: string;
  userId: string;
  filename: string;
  mimeType: string;
  csvText: string;
}): Promise<RulebookIngestResult> {
  const { rows, errors } = parseRulebookCsv(args.csvText);

  // Resolve payerRef (name or uuid) → payer.id. The payer table is
  // global (no RLS) so a breakglass read is correct here.
  const refs = Array.from(
    new Set(rows.map((r) => r.payerRef).filter((v): v is string => !!v)),
  );
  const refToId = new Map<string, string>();
  if (refs.length > 0) {
    const found = await withBreakglass(async (tx) => {
      return tx.$queryRaw<{ ref: string; id: string }[]>`
        SELECT t.ref AS ref, p.id AS id
        FROM unnest(${refs}::text[]) AS t(ref)
        JOIN payer p
          ON p.id::text = t.ref
          OR p.name = t.ref::citext
          OR p.name ILIKE '%' || t.ref || '%'
      `;
    }, "rulebook-upload payer resolve");
    for (const r of found) if (!refToId.has(r.ref)) refToId.set(r.ref, r.id);
  }

  const parsedRows = rows.map((r) => ({
    payerId: r.payerRef ? refToId.get(r.payerRef) ?? null : null,
    state: r.state,
    cptCode: r.cptCode,
    attribute: r.attribute,
    coverageStatus: r.coverageStatus,
    ruleValue: r.ruleValue,
  }));
  const resolvedPayers = parsedRows.filter((r) => r.payerId).length;
  const hash =
    "sha256:" + createHash("sha256").update(args.csvText).digest("hex");

  const uploadId = await withOrgContext(args.orgId, async (tx) => {
    const ins = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO rulebook_upload (
        org_id, filename, mime_type, size_bytes, storage_path,
        status, extraction_started_at, extraction_completed_at,
        parsed_rows, parsed_row_count, uploaded_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${args.filename}, ${args.mimeType},
        ${Buffer.byteLength(args.csvText)}, ${"inline://" + hash},
        ${parsedRows.length > 0 ? "extracted" : "failed"},
        now(), now(),
        ${JSON.stringify(parsedRows)}::jsonb, ${parsedRows.length},
        ${args.userId}::uuid
      )
      RETURNING id
    `;
    return ins[0]!.id;
  });

  return {
    uploadId,
    parsedRowCount: parsedRows.length,
    resolvedPayers,
    errors,
  };
}

export interface DocumentIngestResult {
  sourceDocId: string;
  chunkCount: number;
  embedded: boolean;
}

/**
 * Ingest a free-text policy document: create a `source_document` and
 * chunk + embed it into `document_chunk` so the RAG fallback in
 * rule-lookup can retrieve and cite it.
 */
export async function ingestPolicyDocument(args: {
  payerId: string | null;
  state: string | null;
  url: string;
  title: string;
  text: string;
}): Promise<DocumentIngestResult> {
  const chunks = chunkText(args.text);
  const hash = "sha256:" + createHash("sha256").update(args.text).digest("hex");
  const canEmbed = isEmbedderConfigured();

  // source_document + document_chunk are global (no org_id). Breakglass.
  return withBreakglass(async (tx) => {
    const doc = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO source_document (
        payer_id, url, document_type, title, effective_date,
        retrieved_at, content_hash, cms_license_token_used,
        source_metadata
      ) VALUES (
        ${args.payerId}::uuid, ${args.url}, 'client_upload',
        ${args.title}, NULL, now(), ${hash}, FALSE,
        '{"ingest":"path-b"}'::jsonb
      )
      RETURNING id
    `;
    const sourceDocId = doc[0]!.id;

    let embedded = false;
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i];
      let vec: number[] | null = null;
      if (canEmbed) {
        try {
          vec = await embed(content);
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
            ${sourceDocId}::uuid, ${i}, ${content}, ${lit}::vector,
            ${args.payerId}::uuid, ${args.state}
          )
        `;
      } else {
        await tx.$executeRaw`
          INSERT INTO document_chunk (
            source_doc_id, chunk_index, content, payer_id, state
          ) VALUES (
            ${sourceDocId}::uuid, ${i}, ${content},
            ${args.payerId}::uuid, ${args.state}
          )
        `;
      }
    }

    return { sourceDocId, chunkCount: chunks.length, embedded };
  }, "policy-document ingest");
}
