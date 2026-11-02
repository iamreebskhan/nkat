/** PATCH /api/settings/fees/[id] — end a fee on a day (settings.org). 0118. */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { EndFeeSchema, endPracticeFee } from "@/lib/features/billing/practice-fee.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, EndFeeSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await endPracticeFee({ orgId: session.orgId, userId: session.userId, feeId: id, endOn: body.endOn }));
  } catch (err) {
    return handleServiceError(err);
  }
}
