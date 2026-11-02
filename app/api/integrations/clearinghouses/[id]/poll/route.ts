/**
 * POST /api/integrations/clearinghouses/[id]/poll — check the connection's
 * SFTP folders for responses now, and apply what is new (0120).
 *
 * The files move claim statuses and post 835s with their denials, so this
 * takes what uploading an 835 by hand takes: billing.superbills.edit and
 * billing.denials.log.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { pollConnection } from "@/lib/features/clearinghouse/poll.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.edit", "billing.denials.log"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await pollConnection({ orgId: session.orgId, connectionId: id, userId: session.userId }));
  } catch (err) {
    return handleServiceError(err);
  }
}
