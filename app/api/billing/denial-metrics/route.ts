/**
 * GET /api/billing/denial-metrics — Phase B.3.
 *
 * Per-reason precision/recall from the nightly feedback loop. Powers any
 * "this rule has X% precision" surface. Global platform metadata.
 */
import { type NextRequest } from "next/server";

import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getDenialRuleMetrics } from "@/lib/features/billing/denial-feedback.service";

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.denials.view"]);
  if (session instanceof Response) return session;
  const metrics = await getDenialRuleMetrics();
  return ok({ metrics });
}
