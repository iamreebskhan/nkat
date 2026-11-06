/**
 * POST /api/cron/embed-chunks — nightly: search vectors for the document
 * sections stored without one (embed-backfill.service.ts), so a policy stored
 * while OpenAI could not embed it is searchable by meaning once it can.
 * Shared-secret auth via x-cron-secret, as the other cron routes.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok } from "@/lib/api";
import { embedMissingChunks } from "@/lib/features/documents/embed-backfill.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return fail("CRON_SECRET not configured.", { status: 503 });
  const provided = req.headers.get("x-cron-secret");
  if (provided !== secret) return fail("Unauthorized.", { status: 401 });
  try {
    return ok(await embedMissingChunks());
  } catch (err) {
    return handleServiceError(err);
  }
}
