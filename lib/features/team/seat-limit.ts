/**
 * Seat-limit math — pure, unit-testable.
 *
 * Source of truth for an org's seat cap:
 *   1. `subscription.seats` if the org has a Stripe subscription row.
 *   2. else derive from `org.plan_tier` (every org starts 'solo').
 *
 * `enterprise` (catalog seats = 0) means uncapped.
 *
 * Usage counts BOTH active members and outstanding (un-redeemed,
 * un-expired) invites — an invite holds a seat the moment it's sent,
 * otherwise an org could over-provision by blasting invites.
 */
import { planCatalog, type Tier } from "@/lib/features/billing-saas/stripe.service";

/** Seats for a tier from the catalog. enterprise → Infinity (uncapped). */
export function seatsForTier(tier: Tier): number {
  const entry = planCatalog().find((p) => p.tier === tier);
  if (!entry) return 1; // unknown tier → most conservative
  return entry.seats === 0 ? Infinity : entry.seats;
}

/**
 * Resolve the effective cap. Prefer an explicit subscription seat
 * count (what they actually pay for); fall back to the org's plan_tier.
 */
export function resolveSeatCap(args: {
  subscriptionSeats: number | null;
  planTier: Tier;
}): number {
  if (args.subscriptionSeats != null && args.subscriptionSeats > 0) {
    return args.subscriptionSeats;
  }
  return seatsForTier(args.planTier);
}

/**
 * Would adding ONE more occupant exceed the cap?
 *
 * `reInvitingExisting` = true when the invite targets an email that is
 * already a member or already has a pending invite — that consumes no
 * new seat (the row is updated in place via ON CONFLICT).
 */
export function wouldExceedSeatCap(args: {
  activeMembers: number;
  outstandingInvites: number;
  cap: number;
  reInvitingExisting: boolean;
}): boolean {
  if (args.cap === Infinity) return false;
  if (args.reInvitingExisting) return false;
  const used = args.activeMembers + args.outstandingInvites;
  return used + 1 > args.cap;
}
