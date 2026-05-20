/** Attestation request queue (gaps surfaced by the lookup engine). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listAttestationRequests,
  pushAttestationRequest,
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

/**
 * Flag a missing/unverified rule for the analyst attestation queue.
 * Used by the org-facing Rulebook "Flag for attestation" button when a
 * cell is Unknown.
 */
const PushSchema = z.object({
  payerId: z.string().uuid().nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  cptCode: z.string().min(4).max(5),
  attribute: z.string().min(3).max(40),
  sourceQuery: z.string().max(500).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  // Rulebook editors flag gaps; analysts then claim + resolve.
  const session = await requireAuth(["knowledge.edit"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, PushSchema);
  if (body instanceof Response) return body;
  try {
    const r = await pushAttestationRequest({
      orgId: session.orgId,
      payerId: body.payerId ?? null,
      state: body.state ?? null,
      cptCode: body.cptCode,
      attribute: body.attribute,
      sourceQuery: body.sourceQuery,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
