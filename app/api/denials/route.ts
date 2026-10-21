/**
 * Denials collection — GET (list, filterable) + POST (log).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, parseSearchParams, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listDenials,
  logDenial,
  summarizeDenials,
} from "@/lib/features/denials/denial.service";
import {
  DENIAL_DECISIONS,
  LogDenialSchema,
} from "@/lib/features/denials/denial.types";

const ListSchema = z.object({
  decision: z.enum(DENIAL_DECISIONS).optional(),
  superbillId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.denials.view"]);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const params = parseSearchParams(url, ListSchema);
  if (params instanceof Response) return params;

  const rows = await listDenials({
    orgId: session.orgId,
    ...params,
  });
  // Figures over the whole filtered set, not the page (audit R34).
  // Sequential: parallel withOrgContext transactions exhausted the pool.
  const metrics = await summarizeDenials({
    orgId: session.orgId,
    decision: params.decision,
    superbillId: params.superbillId,
    payerId: params.payerId,
  });
  return ok({ rows, total: metrics.total, metrics });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.denials.log"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, LogDenialSchema);
  if (body instanceof Response) return body;

  try {
    const r = await logDenial({ orgId: session.orgId, payload: body, actorUserId: session.userId });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
