/**
 * POST /api/cron/payer-rule-alerts — nightly alert dispatcher.
 *
 * Auth: shared-secret header `x-cron-secret` matched against env
 * CRON_SECRET. NOT a session-cookie path — this is hit by the
 * scheduler, not a logged-in user.
 *
 * Idempotent: per-org checkpoint advances inside the same tx as the
 * alert send; a re-run within seconds finds no new changes.
 */
import { type NextRequest } from "next/server";

import { ok, fail, handleServiceError } from "@/lib/api";
import { dispatchPayerRuleAlerts } from "@/lib/features/alerts/payer-rule-alerts.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return fail("CRON_SECRET not configured.", { status: 503 });
  }
  const provided = req.headers.get("x-cron-secret");
  if (provided !== secret) {
    return fail("Unauthorized.", { status: 401 });
  }

  try {
    const summaries = await dispatchPayerRuleAlerts();
    return ok({
      ranAt: new Date().toISOString(),
      orgs: summaries,
      totalDigests: summaries.reduce((sum, s) => sum + s.digestsSent, 0),
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
