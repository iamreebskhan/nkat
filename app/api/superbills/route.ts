/** Superbill list — GET. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  SUPERBILL_STATUSES,
  countSuperbills,
  listSuperbills,
} from "@/lib/features/superbills/superbill.service";

const Query = z.object({
  status: z.enum(SUPERBILL_STATUSES).optional(),
  patientId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const rows = await listSuperbills({ orgId: session.orgId, ...params });
  // `total` is the size of the whole filtered list. It was rows.length, which
  // made one page read as the entire queue (audit R34). Sequential, not
  // Promise.all: parallel withOrgContext transactions exhausted the pool on
  // the claims screen.
  const total = await countSuperbills({
    orgId: session.orgId,
    status: params.status,
    patientId: params.patientId,
  });
  return ok({ rows, total, limit: params.limit ?? 50, offset: params.offset ?? 0 });
}
