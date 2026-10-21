/**
 * POST /api/superbills/[id]/correct-date — re-date a bill still being worked
 * to the day its visit started where the practice is (0107), repriced for that
 * day. The bill page offers it when the two differ; see correctDateOfService.
 */
import { type NextRequest } from "next/server";

import { ok, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { correctDateOfService } from "@/lib/features/superbills/superbill.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: Params): Promise<Response> {
  // The permission editing a bill takes (PATCH /api/superbills/[id]).
  const session = await requireAuth(["billing.superbills.create"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await correctDateOfService({ orgId: session.orgId, id, userId: session.userId }));
  } catch (err) {
    return handleServiceError(err);
  }
}
