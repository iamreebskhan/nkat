/** Single attestation: GET + DELETE (soft-void with reason). */
import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getAttestation,
  voidAttestation,
} from "@/lib/features/attestations/attestation.service";
import { VoidAttestationSchema } from "@/lib/features/attestations/attestation.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["knowledge.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const att = await getAttestation({ orgId: session.orgId, id });
  if (!att) return fail("Attestation not found.", { status: 404 });
  return ok(att);
}

export async function DELETE(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["knowledge.attest"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const body = await parseJson(req, VoidAttestationSchema);
  if (body instanceof Response) return body;
  await voidAttestation({
    orgId: session.orgId,
    id,
    byUserId: session.userId,
    reason: body.reason,
  });
  return ok({ id });
}
