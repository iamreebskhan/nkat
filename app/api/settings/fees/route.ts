/**
 * The practice's fee schedule (0118; Level-1 doc:74; Mark Q4 default). See
 * practice-fee.service.ts.
 *
 *   GET  — every fee, in force and ended (settings.view)
 *   POST — set a code's fee from a day (settings.org)
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { SetFeeSchema, listPracticeFees, setPracticeFee } from "@/lib/features/billing/practice-fee.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await listPracticeFees({ orgId: session.orgId }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, SetFeeSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await setPracticeFee({ orgId: session.orgId, userId: session.userId, payload: body }), { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
