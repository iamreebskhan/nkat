/** Attestations collection — list (filterable) + create. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, parseSearchParams, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  createAttestation,
  listAttestations,
  sweepExpired,
} from "@/lib/features/attestations/attestation.service";
import {
  ATTESTATION_LIFECYCLES,
  CreateAttestationSchema,
} from "@/lib/features/attestations/attestation.types";

const ListSchema = z.object({
  status: z.enum(ATTESTATION_LIFECYCLES).optional(),
  payerId: z.string().uuid().optional(),
  cptCode: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), ListSchema);
  if (params instanceof Response) return params;
  // Opportunistic expiry sweep on read — without this, rows past expires_at
  // stayed "active" forever (the documented daily cron was never built).
  await sweepExpired({ orgId: session.orgId }).catch(() => undefined);
  const rows = await listAttestations({ orgId: session.orgId, ...params });
  return ok({ rows, total: rows.length });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.attest"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, CreateAttestationSchema);
  if (body instanceof Response) return body;
  try {
    const r = await createAttestation({
      orgId: session.orgId,
      attestedByUserId: session.userId,
      payload: body,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
