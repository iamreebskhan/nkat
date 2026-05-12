/** Superbill list — GET. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { SUPERBILL_STATUSES, listSuperbills } from "@/lib/features/superbills/superbill.service";

const Query = z.object({
  status: z.enum(SUPERBILL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const rows = await listSuperbills({ orgId: session.orgId, ...params });
  return ok({ rows, total: rows.length });
}
