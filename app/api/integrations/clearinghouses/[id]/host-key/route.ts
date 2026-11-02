/**
 * DELETE /api/integrations/clearinghouses/[id]/host-key — forget the SFTP
 * server's pinned host key (0120), for when the clearinghouse says it changed
 * it. The next test records whatever key the server then presents.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { resetHostKey } from "@/lib/features/clearinghouse/connection.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await resetHostKey({ orgId: session.orgId, userId: session.userId, id }));
  } catch (err) {
    return handleServiceError(err);
  }
}
