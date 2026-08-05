/**
 * GET /api/superbills/[id]/activity — the bill's append-only history.
 *
 * Client walkthrough [06:09]: "activity history lazmi likhna: ke yeh pehle
 * bill tha, yeh reject hua, aur ab yeh new bill hai." Created → submitted →
 * denied → corrected → resubmitted, newest first.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listSuperbillActivity } from "@/lib/features/superbills/superbill.service";

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
    const rows = await listSuperbillActivity({ orgId: session.orgId, superbillId: id });
    return ok({ rows, total: rows.length });
  } catch (err) {
    return handleServiceError(err);
  }
}
