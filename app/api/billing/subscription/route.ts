/** GET /api/billing/subscription — read the cached subscription row. */
import { ok, fail } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

import { withOrgContext } from "@/lib/db";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.view"]);
  if (session instanceof Response) return session;

  const row = await withOrgContext(session.orgId, async (tx) => {
    const r = await tx.$queryRaw<
      {
        tier: string;
        seats: number;
        status: string;
        current_period_end: Date | null;
        cancel_at_period_end: boolean;
      }[]
    >`
      SELECT tier, seats, status, current_period_end, cancel_at_period_end
      FROM subscription WHERE org_id = ${session.orgId}::uuid LIMIT 1
    `;
    return r[0] ?? null;
  });

  if (!row) {
    return fail("No subscription on file. Pick a plan to start.", { status: 404 });
  }

  return ok({
    tier: row.tier,
    seats: row.seats,
    status: row.status,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  });
}
