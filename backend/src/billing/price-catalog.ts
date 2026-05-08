/**
 * Tier → Stripe Price ID resolver.
 *
 * Stripe Price objects are created out-of-band (manually in dashboard or
 * via Terraform) per tier. We don't rotate price IDs at runtime; we just
 * resolve them from env at startup.
 *
 * Env contract:
 *   STRIPE_PRICE_SOLO=price_...
 *   STRIPE_PRICE_TEAM=price_...
 *   STRIPE_PRICE_ORG=price_...
 *   STRIPE_PRICE_ENTERPRISE=price_...    (optional — Enterprise is contracted)
 *
 * Used by the Checkout-session endpoint and by ops scripts that create
 * subscriptions out-of-band.
 */
import type { SubscriptionTier } from './billing-types';

export function resolvePriceId(
  tier: SubscriptionTier,
  envSource: NodeJS.ProcessEnv = process.env,
): string | null {
  switch (tier) {
    case 'solo':       return envSource.STRIPE_PRICE_SOLO ?? null;
    case 'team':       return envSource.STRIPE_PRICE_TEAM ?? null;
    case 'org':        return envSource.STRIPE_PRICE_ORG ?? null;
    case 'enterprise': return envSource.STRIPE_PRICE_ENTERPRISE ?? null;
  }
}

/**
 * Returns the set of tiers that are self-serve checkoutable. Enterprise
 * is excluded — it's contracted via Sales / Order Form, not Checkout.
 */
export const SELF_SERVE_TIERS: SubscriptionTier[] = ['solo', 'team', 'org'];

export function isSelfServeTier(t: SubscriptionTier): boolean {
  return SELF_SERVE_TIERS.includes(t);
}
