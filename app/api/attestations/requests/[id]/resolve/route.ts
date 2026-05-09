/** Analyst resolves a request by attaching the new attestation row id. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { resolveRequest } from "@/lib/features/attestations/attestation.service";

const Body = z.object({
  attestationId: z.string().uuid(),
  note: z.string().max(2000).optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["knowledge.attest"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  await resolveRequest({
    orgId: session.orgId,
    id,
    attestationId: body.attestationId,
    note: body.note,
  });
  return ok({ id });
}
