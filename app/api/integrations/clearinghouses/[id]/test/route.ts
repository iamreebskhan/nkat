/**
 * POST /api/integrations/clearinghouses/[id]/test — test each channel of the
 * connection without sending any patient's data (0120): SFTP connects, pins
 * the server's host key on a first test and lists the folders; CORE answers
 * over TLS; Availity's API issues a token.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { testConnection } from "@/lib/features/clearinghouse/connection.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await testConnection({ orgId: session.orgId, userId: session.userId, id }));
  } catch (err) {
    return handleServiceError(err);
  }
}
