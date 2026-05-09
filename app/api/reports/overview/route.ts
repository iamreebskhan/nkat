/** Reports overview — one-call dashboard aggregator. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getOverview } from "@/lib/features/reports/reports.service";

const Query = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const overview = await getOverview({
    orgId: session.orgId,
    fromDate: params.fromDate ? new Date(`${params.fromDate}T00:00:00Z`) : undefined,
    toDate: params.toDate ? new Date(`${params.toDate}T23:59:59Z`) : undefined,
  });
  return ok(overview);
}
