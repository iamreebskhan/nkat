/** Analyst resolves a request by attaching the new attestation row id. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
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
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  // resolveRequest refuses an attestation id this org cannot see, and says so
  // with a NotFoundError. Every sibling route under app/api/attestations has
  // carried this catch; without it here that refusal left the service as an
  // uncaught throw and reached the analyst as an opaque 500, so the sentence
  // the service writes for them was never the sentence they read.
  try {
    await resolveRequest({
      orgId: session.orgId,
      id,
      attestationId: body.attestationId,
      note: body.note,
    });
    return ok({ id });
  } catch (err) {
    return handleServiceError(err);
  }
}
