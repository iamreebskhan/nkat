/** POST /api/settings/ncci/loads/[id]/rows — a batch of PTP pairs or MUE values onto a load (settings.org). 0122. */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { NcciRowsSchema, addNcciRows } from "@/lib/features/billing/ncci-load.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, NcciRowsSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await addNcciRows({ orgId: session.orgId, loadId: id, payload: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
