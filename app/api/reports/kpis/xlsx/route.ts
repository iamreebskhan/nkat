/**
 * GET /api/reports/kpis/xlsx — the KPI report as an Excel workbook: the table,
 * the year-over-year table and the definitions. reports.export, as taking a
 * report out of Pallio is. Counts and money only, so it is not a PHI disclosure.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { KpiQuerySchema } from "@/lib/features/reports/kpi-report";
import { getKpiYearOverYear } from "@/lib/features/reports/kpi-report.service";
import { kpiWorkbook } from "@/lib/features/reports/kpi-workbook";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.export"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), KpiQuerySchema);
  if (params instanceof Response) return params;
  try {
    const { report, year } = await getKpiYearOverYear({ orgId: session.orgId, fromDay: params.fromDate, toDay: params.toDate });
    return new Response(Buffer.from(kpiWorkbook(report, year)), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="pallio-kpis-${report.range.fromDate}-to-${report.range.toDate}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
