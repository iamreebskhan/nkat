/**
 * GET /api/schedule/time-zone — the practice's clock, which the schedule, its
 * booking form and the route sheet all run on. Any signed-in member: it says
 * only where the practice is.
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { orgToday, orgZoneName } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  try {
    const timeZone = await withOrgContext(session.orgId, (tx) => readOrgTimeZone(tx, session.orgId));
    return ok({ timeZone, today: orgToday(timeZone), zoneName: orgZoneName(timeZone) });
  } catch (err) {
    return handleServiceError(err);
  }
}
