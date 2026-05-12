/**
 * Source document reader — surfaces the platform's payer-policy
 * corpus for analysts.
 *
 * The `source_document` table is global (no org_id) — payer policy
 * documents are reference data shared across tenants.
 */
import { prisma } from "@/lib/db";

export interface SourceDocumentView {
  id: string;
  documentType: string;
  title: string | null;
  url: string;
  payerId: string | null;
  payerName: string | null;
  effectiveDate: string | null;
  retrievedAt: string;
  extractedAt: string | null;
  extractionCandidateCount: number;
  extractionError: string | null;
}

export interface DocumentStats {
  total: number;
  pendingExtraction: number;
  withErrors: number;
}

export async function listSourceDocuments(args: {
  documentType?: string;
  payerId?: string;
  limit?: number;
}): Promise<SourceDocumentView[]> {
  const limit = Math.min(200, args.limit ?? 100);
  const rows = await prisma.$queryRaw<
    {
      id: string;
      document_type: string;
      title: string | null;
      url: string;
      payer_id: string | null;
      payer_name: string | null;
      effective_date: Date | null;
      retrieved_at: Date;
      extracted_at: Date | null;
      extraction_candidate_count: number;
      extraction_error: string | null;
    }[]
  >`
    SELECT d.id, d.document_type, d.title, d.url, d.payer_id, p.name AS payer_name,
           d.effective_date, d.retrieved_at, d.extracted_at,
           d.extraction_candidate_count, d.extraction_error
    FROM source_document d
    LEFT JOIN payer p ON p.id = d.payer_id
    WHERE (${args.documentType ?? null}::text IS NULL OR d.document_type = ${args.documentType ?? null})
      AND (${args.payerId ?? null}::uuid IS NULL OR d.payer_id = ${args.payerId ?? null}::uuid)
    ORDER BY d.retrieved_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    documentType: r.document_type,
    title: r.title,
    url: r.url,
    payerId: r.payer_id,
    payerName: r.payer_name,
    effectiveDate: r.effective_date?.toISOString().slice(0, 10) ?? null,
    retrievedAt: r.retrieved_at.toISOString(),
    extractedAt: r.extracted_at?.toISOString() ?? null,
    extractionCandidateCount: r.extraction_candidate_count,
    extractionError: r.extraction_error,
  }));
}

export async function documentStats(): Promise<DocumentStats> {
  const rows = await prisma.$queryRaw<
    { total: bigint; pending: bigint; errors: bigint }[]
  >`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE extracted_at IS NULL AND extraction_error IS NULL) AS pending,
           COUNT(*) FILTER (WHERE extraction_error IS NOT NULL) AS errors
    FROM source_document
  `;
  const r = rows[0]!;
  return {
    total: Number(r.total),
    pendingExtraction: Number(r.pending),
    withErrors: Number(r.errors),
  };
}
