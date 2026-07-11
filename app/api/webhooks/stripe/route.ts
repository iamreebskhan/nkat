/**
 * Stripe webhook receiver.
 *
 * Stripe POSTs raw JSON + a signature header. We MUST verify the
 * signature using the original raw body — Next.js JSON parsing would
 * break the canonical-bytes contract. Hence reading req.text().
 *
 * Stripe expects a 2xx in <30s; the handler is idempotent.
 */
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api";
import { handleStripeWebhook } from "@/lib/features/billing-saas/stripe.service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return fail("Missing stripe-signature header.", { status: 400 });
  }
  const rawBody = await req.text();

  try {
    const result = await handleStripeWebhook({ signature, rawBody });
    return ok(result);
  } catch (err) {
    // Bad signature → 400 so Stripe doesn't retry. Other errors → 500
    // so Stripe retries with backoff.
    const msg = err instanceof Error ? err.message : "Webhook failed";
    if (/signature/i.test(msg)) {
      return fail(msg, { status: 400 });
    }
    return fail(msg, { status: 500 });
  }
}
