/**
 * GET /api/reports/kpis/year-over-year — the Trend Report's YoY table for a
 * window of the practice's days (?fromDate=&toDate=, the last twelve months by
 * default) beside the same days a year before. Counts and money only.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { KpiQuerySchema } from "@/lib/features/reports/kpi-report";
import { getKpiYearOverYear } from "@/lib/features/reports/kpi-report.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), KpiQuerySchema);
  if (params instanceof Response) return params;
  try {
    const { year } = await getKpiYearOverYear({ orgId: session.orgId, fromDay: params.fromDate, toDay: params.toDate });
    return ok(year);
  } catch (err) {
    return handleServiceError(err);
  }
}
