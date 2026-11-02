/**
 * The practice's monthly figures (0125).
 *
 *   GET ?year=  a year of them, with the measures a month can carry
 *   PUT         what changed: a figure entered, or cleared with value null
 *
 * Reading goes with the KPI report (reports.view). Entering them changes every
 * report the practice takes, so it needs settings.org.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { KpiHistoryQuerySchema, SaveKpiHistorySchema } from "@/lib/features/reports/kpi-history";
import { getKpiHistoryYear, saveKpiHistory } from "@/lib/features/reports/kpi-history.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), KpiHistoryQuerySchema);
  if (params instanceof Response) return params;
  try {
    return ok(await getKpiHistoryYear({ orgId: session.orgId, year: params.year }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, SaveKpiHistorySchema);
  if (body instanceof Response) return body;
  try {
    return ok(await saveKpiHistory({ orgId: session.orgId, userId: session.userId, changes: body.changes }));
  } catch (err) {
    return handleServiceError(err);
  }
}
