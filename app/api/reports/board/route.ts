/**
 * GET /api/reports/board?month=YYYY-MM — the month's board report as data, for
 * the page to show what to check before anything is downloaded. The last whole
 * month by default. Counts and money only.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { BoardQuerySchema } from "@/lib/features/reports/board-report";
import { getBoardReport } from "@/lib/features/reports/board-report.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), BoardQuerySchema);
  if (params instanceof Response) return params;
  try {
    return ok(await getBoardReport({ orgId: session.orgId, month: params.month }));
  } catch (err) {
    return handleServiceError(err);
  }
}
