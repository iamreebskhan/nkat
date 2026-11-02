/**
 * GET /api/reports/kpis — the practice's KPI report (Level-1 doc:80-109): every
 * measure by month across a window of the practice's days (?fromDate=&toDate=,
 * the last twelve months by default). Counts and money only: no patient is
 * named in it.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { KpiQuerySchema } from "@/lib/features/reports/kpi-report";
import { getKpiReport } from "@/lib/features/reports/kpi-report.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), KpiQuerySchema);
  if (params instanceof Response) return params;
  try {
    return ok(await getKpiReport({ orgId: session.orgId, fromDay: params.fromDate, toDay: params.toDate }));
  } catch (err) {
    // A backwards or over-long window is a 422 with its reason (report-range).
    return handleServiceError(err);
  }
}
