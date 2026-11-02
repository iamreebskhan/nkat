/**
 * POST /api/superbills/[id]/claim-status — ask the payer, through the
 * clearinghouse, where this claim stands (0120; 276/277). The answer goes on
 * the claim's history; it never moves the claim (the 835 is the payer's word
 * on money).
 *
 * Body (optional): { connectionId } — the connection to ask; the main one
 * with a real-time channel when absent.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { checkClaimStatus } from "@/lib/features/clearinghouse/realtime.service";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

interface Params {
  params: Promise<{ id: string }>;
}

const Body = z.object({ connectionId: z.string().uuid().optional().nullable() }).strict();

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  // No JSON body asks the main connection, as the route did before it took one.
  let body: z.infer<typeof Body> = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    const parsed = await parseJson(req, Body);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  }
  try {
    return ok(await checkClaimStatus({ orgId: session.orgId, userId: session.userId, superbillId: id, connectionId: body.connectionId ?? null }));
  } catch (err) {
    return handleServiceError(err);
  }
}
