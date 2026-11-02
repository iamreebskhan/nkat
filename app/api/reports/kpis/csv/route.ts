/**
 * GET /api/reports/kpis/csv — the KPI report as a spreadsheet (doc:80-109):
 * each measure and its parts with its definition, a column a month and the
 * window's. reports.export, as taking a report out of Pallio is. Counts and
 * money only, so it is not a PHI disclosure.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { KpiQuerySchema, kpiCsv } from "@/lib/features/reports/kpi-report";
import { getKpiReport } from "@/lib/features/reports/kpi-report.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.export"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), KpiQuerySchema);
  if (params instanceof Response) return params;
  try {
    const report = await getKpiReport({ orgId: session.orgId, fromDay: params.fromDate, toDay: params.toDate });
    return new Response(kpiCsv(report), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="pallio-kpis-${report.range.fromDate}-to-${report.range.toDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
