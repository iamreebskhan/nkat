/**
 * POST /api/settings/ncci/loads — start a load of CMS's NCCI files: what kind,
 * which files, and for MUE values the date they apply from (settings.org).
 * Answers its id and the codes PTP pairs are kept for. 0122.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { StartNcciLoadSchema, startNcciLoad } from "@/lib/features/billing/ncci-load.service";

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, StartNcciLoadSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await startNcciLoad({ orgId: session.orgId, userId: session.userId, payload: body }), { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
