/**
 * GET /api/remittances/[id] — one uploaded 835's lines: what each claim
 * posted as, and the bill it matched (audit R10).
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listRemittanceLines } from "@/lib/features/remittances/remittance.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const lines = await listRemittanceLines({ orgId: session.orgId, fileId: id });
    return ok({ lines });
  } catch (err) {
    return handleServiceError(err);
  }
}
