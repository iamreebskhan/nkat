/** POST /api/billing/checkout — create Stripe Checkout Session for the requested tier. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  createCheckoutSession,
  isStripeConfigured,
} from "@/lib/features/billing-saas/stripe.service";

const Body = z.object({
  tier: z.enum(["solo", "team", "org"]),
});

export async function POST(req: NextRequest): Promise<Response> {
  if (!isStripeConfigured()) {
    return fail("Billing not configured. Contact sales@pallio.io.", { status: 503 });
  }
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  try {
    const r = await createCheckoutSession({
      orgId: session.orgId,
      userEmail: session.email,
      tier: body.tier,
      successUrl: `${env().APP_BASE_URL}/settings/billing?status=success`,
      cancelUrl: `${env().APP_BASE_URL}/settings/billing?status=cancel`,
    });
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Checkout failed", { status: 500 });
  }
}
