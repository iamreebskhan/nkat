/**
 * POST /api/admin/ingestion-sources/[id]/run — manually re-ingest one
 * configured source on demand (in addition to the scheduled cron).
 *
 * Platform-admin gated. Wraps runIngestionCron's single-source path:
 * fetches, hashes, dedupe-checks, extracts rules, writes
 * source_document + chunks + payer_rule.
 */
import { type NextRequest } from "next/server";

import { ok, fail, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withBreakglass } from "@/lib/db";
import { ingestDocumentFromUrl } from "@/lib/features/ingestion/document-ingestion.service";

interface Params {
  params: Promise<{ id: string }>;
}

interface SrcRow {
  id: string;
  url: string;
  payer_id: string | null;
  state: string | null;
  document_type: string;
  name: string;
  last_content_hash: string | null;
}

export async function POST(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  const rows = await withBreakglass(async (tx) => {
    return tx.$queryRaw<SrcRow[]>`
      SELECT id, url, payer_id, state, document_type, name, last_content_hash
      FROM ingestion_source WHERE id = ${id}::uuid LIMIT 1
    `;
  }, "ingestion-source: load for manual run");
  const src = rows[0];
  if (!src) return fail("Source not found.", { status: 404 });

  try {
    const r = await ingestDocumentFromUrl({
      url: src.url,
      payerId: src.payer_id,
      state: src.state,
      // The CHECK constraint on the column already restricts to the
      // allowed enum; cast is safe.
      documentType:
        src.document_type as Parameters<typeof ingestDocumentFromUrl>[0]["documentType"],
      title: src.name,
    });
    const changed = r.contentHash !== src.last_content_hash && !r.alreadyIngested;
    await withBreakglass(async (tx) => {
      await tx.$executeRaw`
        UPDATE ingestion_source SET
          last_check_at     = now(),
          last_content_hash = ${r.contentHash},
          last_ingested_at  = CASE WHEN ${changed} THEN now() ELSE last_ingested_at END,
          last_error        = NULL,
          updated_at        = now()
        WHERE id = ${id}::uuid
      `;
    }, "ingestion-source: update bookkeeping after manual run");
    return ok({ changed, ...r });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await withBreakglass(async (tx) => {
      await tx.$executeRaw`
        UPDATE ingestion_source SET
          last_check_at = now(), last_error = ${msg.slice(0, 500)},
          updated_at = now()
        WHERE id = ${id}::uuid
      `;
    }, "ingestion-source: record manual-run error");
    return fail(msg, { status: 422 });
  }
}
