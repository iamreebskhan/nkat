/**
 * POST /api/cron/ingest-documents — scheduled re-ingestion of every
 * active ingestion_source whose cadence has elapsed.
 *
 * Auth: shared-secret header `x-cron-secret` matched against env
 * CRON_SECRET (same pattern as the payer-rule-alerts cron). Not a
 * session-cookie endpoint.
 *
 * Walks the registry, fetches each URL, dedupes on content_hash,
 * extracts rules via Claude, writes payer_rule + source_document +
 * document_chunk. Errors per source are recorded on the row and
 * skipped; the batch never fails for a single bad URL.
 */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { runIngestionCron } from "@/lib/features/ingestion/sources.service";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // some payer PDFs + Claude calls are slow

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return fail("CRON_SECRET not configured.", { status: 503 });
  }
  const provided = req.headers.get("x-cron-secret");
  if (provided !== secret) {
    return fail("Unauthorized.", { status: 401 });
  }

  try {
    const summary = await runIngestionCron();
    return ok(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion cron crashed.";
    return fail(message, { status: 500 });
  }
}
