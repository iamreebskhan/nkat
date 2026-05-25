/**
 * POST /api/cron/denial-feedback — Phase B nightly aggregator.
 *
 * Joins every persisted superbill's predicted_risk with the eventual
 * denial outcome, recomputes precision/recall per reason_code, and
 * UPSERTs into denial_rule_metrics. Shared-secret auth via
 * x-cron-secret header (same pattern as the other cron routes).
 */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { runDenialFeedback } from "@/lib/features/billing/denial-feedback.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return fail("CRON_SECRET not configured.", { status: 503 });
  const provided = req.headers.get("x-cron-secret");
  if (provided !== secret) return fail("Unauthorized.", { status: 401 });
  try {
    const summary = await runDenialFeedback();
    return ok(summary);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Cron crashed.", { status: 500 });
  }
}
