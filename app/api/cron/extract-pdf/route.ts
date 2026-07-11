/**
 * POST /api/cron/extract-pdf — extract rules from ONE PDF chunk supplied
 * inline (multipart), then persist them as payer_rule.
 *
 * This is the sink for chunked ingestion of oversized rulings (e.g. the
 * 1,216-page CY2026 PFS final rule, which is 2x the page limit and 6.6x the
 * 32 MB size limit — no model can take it whole). A splitter (see
 * scripts/ingest-full-rule-chunked.mjs) cuts the rule into ≤40-page chunks and
 * POSTs each here; every chunk goes through the same extractor + payer_rule
 * writer as the URL-ingestion path.
 *
 * Auth: shared-secret `x-cron-secret` (same trust boundary as the ingest cron,
 * which also writes global rules). Not a session endpoint.
 *
 * multipart/form-data:
 *   file          the PDF chunk (≤ 40 MB)
 *   payerId       REQUIRED — rules only persist with a payer + state
 *   state         REQUIRED
 *   documentType  default 'cms_pfs'
 *   title         label for provenance (e.g. "CY2026 PFS Final Rule pp 1-40")
 *   url           citation target (e.g. the full-rule URL) — same for all chunks
 */
import { type NextRequest } from "next/server";

import { ok, fail, handleServiceError } from "@/lib/api";
import {
  ingestDocumentFromUrl,
  type IngestableDocumentType,
} from "@/lib/features/ingestion/document-ingestion.service";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // Opus extraction on a dense chunk is slow

const MAX_BYTES = 40 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return fail("CRON_SECRET not configured.", { status: 503 });
  if (req.headers.get("x-cron-secret") !== secret) {
    return fail("Unauthorized.", { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("Expected multipart/form-data with a 'file' field.", { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return fail("No file provided.", { status: 400 });
  if (file.size > MAX_BYTES) {
    return fail(`Chunk too large (max ${MAX_BYTES / 1024 / 1024} MB) — split into more pages.`, { status: 413 });
  }

  const payerId = form.get("payerId")?.toString() || null;
  const state = form.get("state")?.toString() || null;
  if (!payerId || !state) {
    return fail("payerId and state are required — rules only persist with both.", { status: 400 });
  }
  const documentType = (form.get("documentType")?.toString() || "cms_pfs") as IngestableDocumentType;
  const title = form.get("title")?.toString() || file.name;
  const url = form.get("url")?.toString() || `inline://${file.name}`;

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  try {
    const r = await ingestDocumentFromUrl({
      url,
      inlinePdfBase64: base64,
      payerId,
      state,
      documentType,
      title,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
