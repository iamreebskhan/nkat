/** Attestation request queue (gaps surfaced by the lookup engine). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listAttestationRequests,
} from "@/lib/features/attestations/attestation.service";
import { REQUEST_STATUSES } from "@/lib/features/attestations/attestation.types";

const ListSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), ListSchema);
  if (params instanceof Response) return params;
  const rows = await listAttestationRequests({ orgId: session.orgId, ...params });
  return ok({ rows, total: rows.length });
}
