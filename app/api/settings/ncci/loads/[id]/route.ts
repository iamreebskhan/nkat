/**
 * DELETE /api/settings/ncci/loads/[id] — drop a load still being sent, or stop
 * using one in use (settings.org). 0122.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { removeNcciLoad } from "@/lib/features/billing/ncci-load.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    await removeNcciLoad({ orgId: session.orgId, userId: session.userId, loadId: id });
    return ok({ removed: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
