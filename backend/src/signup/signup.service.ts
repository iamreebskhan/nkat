/**
 * SignupService — the public-facing self-serve onboarding flow.
 *
 *   1. Receives validated input (company, admin email, tier, quantity, ...).
 *   2. Resolves the Stripe price id for the requested tier.
 *   3. Inserts a new `org` row (admin connection — no RLS context yet).
 *   4. Creates a Stripe Checkout session stamped with metadata.org_id.
 *   5. Inserts a `signup_attempt` row tying it all together.
 *
 * The service is pure orchestration over the StripeClient + Db; unit
 * tests stub the Stripe call and pass a real / fake Db.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database, SubscriptionTier } from '../database/schema.types';
import type { SpecialtyPack, StripeClient } from '../billing/billing-types';
import { isSelfServeTier, resolvePriceId } from '../billing/price-catalog';
import { runWithTenant } from '../database/rls-transaction';
import { InviteService } from '../invites/invite.service';
import { clampTrialDays, slugFromCompanyName, suffixedSlug } from './signup-pure';

export interface SignupStartInput {
  company_name: string;
  admin_email: string;
  tier: 'solo' | 'team' | 'org';
  quantity: number;
  success_url: string;
  cancel_url: string;
  states?: string[];
  specialty_packs?: SpecialtyPack[];
  trial_days?: number;
  source_ip?: string | null;
  source_user_agent?: string | null;
}

export interface SignupStartResult {
  org_id: string;
  signup_attempt_id: string;
  checkout_url: string;
  /** First admin invite token (raw). Caller transmits via email/manual. */
  admin_invite_token: string;
  admin_invite_expires_at: string;
}

@Injectable()
export class SignupService {
  private readonly log = new Logger(SignupService.name);
  constructor(
    private readonly db: Kysely<Database>,
    private readonly stripe: StripeClient | undefined,
    private readonly invites: InviteService,
  ) {}

  async start(input: SignupStartInput): Promise<SignupStartResult> {
    if (!this.stripe?.createCheckoutSession) {
      throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED' });
    }
    if (!isSelfServeTier(input.tier)) {
      throw new ServiceUnavailableException({ code: 'TIER_NOT_SELF_SERVE', tier: input.tier });
    }
    const priceId = resolvePriceId(input.tier as SubscriptionTier);
    if (!priceId) {
      throw new ServiceUnavailableException({ code: 'PRICE_NOT_CONFIGURED', tier: input.tier });
    }

    const trialDays = clampTrialDays(input.trial_days);

    // 1. Allocate a unique slug. Try base; on UNIQUE conflict, append a
    //    6-char suffix. We bound the retry loop to keep things finite.
    const baseSlug = slugFromCompanyName(input.company_name);
    let slug = baseSlug;
    let orgId: string | null = null;
    for (let attempt = 0; attempt < 5 && !orgId; attempt++) {
      const candidate =
        attempt === 0 ? baseSlug : suffixedSlug(baseSlug, randomBytes(4).toString('hex'));
      try {
        const r = await this.db
          .insertInto('org')
          .values({
            name: input.company_name,
            slug: candidate,
            plan_tier: input.tier,
            primary_contact_email: input.admin_email,
            status: 'active',
            metadata: {},
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        orgId = r.id;
        slug = candidate;
      } catch (e) {
        // Retry on UNIQUE(slug). Other errors bubble.
        if (!(e instanceof Error) || !/duplicate|unique/i.test(e.message)) {
          throw e;
        }
      }
    }
    if (!orgId) {
      throw new ServiceUnavailableException({ code: 'SLUG_ALLOCATION_FAILED' });
    }

    // 2. Create Stripe Checkout session.
    let session: { id: string; url: string };
    try {
      session = await this.stripe.createCheckoutSession({
        priceId,
        quantity: input.quantity,
        successUrl: input.success_url,
        cancelUrl: input.cancel_url,
        customerEmail: input.admin_email,
        orgId,
        tier: input.tier,
        states: input.states,
        specialty_packs: input.specialty_packs,
        trialDays,
      });
    } catch (e) {
      // Roll back the org if Stripe rejects the session — leaving an
      // orphaned org would pollute analytics + slug namespace.
      await this.db.deleteFrom('org').where('id', '=', orgId).execute();
      throw e;
    }

    // 3. Record the attempt.
    const ip = input.source_ip ?? null;
    const ua = input.source_user_agent ? input.source_user_agent.slice(0, 256) : null;
    const attempt = await this.db
      .insertInto('signup_attempt')
      .values({
        org_id: orgId,
        company_name: input.company_name,
        admin_email: input.admin_email.toLowerCase(),
        tier: input.tier,
        quantity: input.quantity,
        states: input.states ?? [],
        specialty_packs: input.specialty_packs ?? [],
        trial_days: trialDays,
        stripe_checkout_session_id: session.id,
        source_ip: ip,
        source_user_agent: ua,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // 4. Create the admin app_user + org_member, and issue the first
    //    invite. The org_member is `invited` until redemption flips it
    //    to `active` — so an unredeemed signup leaves no privileged
    //    user able to log in.
    const adminEmail = input.admin_email.toLowerCase();
    const adminUserId = await runWithTenant(this.db, orgId, async (tx) => {
      // Find or create the user (a returning customer's email may
      // already have an app_user row tied to a different org).
      const existing = await tx
        .selectFrom('app_user')
        .select(['id'])
        .where('email', '=', adminEmail)
        .executeTakeFirst();
      const userId = existing
        ? existing.id
        : (
            await tx
              .insertInto('app_user')
              .values({
                email: adminEmail,
                full_name: null,
                password_hash: null,
                mfa_secret: null,
                status: 'active',
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
      await tx
        .insertInto('org_member')
        .values({ org_id: orgId!, user_id: userId, role: 'admin', status: 'invited' })
        .onConflict((oc) => oc.columns(['org_id', 'user_id']).doNothing())
        .execute();
      return userId;
    });

    const invite = await this.invites.issue({
      orgId,
      userId: adminUserId,
      role: 'admin',
    });

    this.log.log(`signup.start org=${orgId} slug=${slug} session=${session.id} invite=ok`);
    return {
      org_id: orgId,
      signup_attempt_id: attempt.id,
      checkout_url: session.url,
      admin_invite_token: invite.rawToken,
      admin_invite_expires_at: invite.expiresAt.toISOString(),
    };
  }
}
