/** Analyst claims a request (transitions open → in_progress). */
import { type NextRequest } from "next/server";

import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { claimRequest } from "@/lib/features/attestations/attestation.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["knowledge.attest"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  await claimRequest({ orgId: session.orgId, id, byUserId: session.userId });
  return ok({ id });
}
