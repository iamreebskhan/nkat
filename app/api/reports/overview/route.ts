/** Reports overview — one-call dashboard aggregator. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { isCalendarDay } from "@/lib/features/org/org-date";
import { getOverview } from "@/lib/features/reports/reports.service";

// A day that does not exist (2026-09-31) is refused here: bound into ::date
// below, Postgres refuses it and the answer would be a 500.
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDay, "Not a calendar day.");

const Query = z.object({
  fromDate: Day.optional(),
  toDate: Day.optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  // The practice's calendar days, passed through as they came: turned into
  // instants (T00:00:00Z / T23:59:59Z) they landed on other days in any
  // database session not running in UTC.
  const overview = await getOverview({
    orgId: session.orgId,
    fromDay: params.fromDate,
    toDay: params.toDate,
  });
  return ok(overview);
}
