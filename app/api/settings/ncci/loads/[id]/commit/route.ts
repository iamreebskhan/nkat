/** POST /api/settings/ncci/loads/[id]/commit — use a load from now on, in place of the one it replaces (settings.org). 0122. */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { CommitNcciLoadSchema, commitNcciLoad } from "@/lib/features/billing/ncci-load.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, CommitNcciLoadSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await commitNcciLoad({ orgId: session.orgId, userId: session.userId, loadId: id, rowsRead: body.rowsRead }));
  } catch (err) {
    return handleServiceError(err);
  }
}
