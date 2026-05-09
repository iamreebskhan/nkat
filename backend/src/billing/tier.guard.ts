/**
 * TierGuard — enforces the entitlement contract on tier-gated endpoints.
 *
 *   @UseGuards(AuthGuard, TierGuard)
 *   @RequiresEntitlement({ specialty_pack: 'oncology' })
 *   @Post('foo') ...
 *
 * Reject reasons (403):
 *   - NO_SUBSCRIPTION   — the org has no row at all
 *   - PAYMENT_REQUIRED  — status is past_due/unpaid AND the route is a write
 *   - CANCELED          — status is canceled
 *   - PACK_NOT_LICENSED — required specialty pack not in the entitlement
 *   - STATE_NOT_LICENSED — request `state` not in entitlement.states
 *
 * Read endpoints during a grace period (past_due/unpaid) are allowed so
 * the customer can still see their data while resolving billing — write
 * endpoints are blocked. The Reflector metadata `requires` declares
 * which checks fire on a route.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BillingService } from './billing.service';
import type { SpecialtyPack } from './billing-types';

export interface RequiresEntitlement {
  specialty_pack?: SpecialtyPack;
  /** When true, the route is a write — payment-grace blocks it. */
  write?: boolean;
}

export const REQUIRES_KEY = 'tier-guard:requires';
export const RequiresEntitlement = (req: RequiresEntitlement) => SetMetadata(REQUIRES_KEY, req);

@Injectable()
export class TierGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requires =
      this.reflector.getAllAndOverride<RequiresEntitlement | undefined>(REQUIRES_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? {};

    const req = ctx.switchToHttp().getRequest<Request>();
    const orgId = req.auth?.orgId;
    if (!orgId) {
      throw new ForbiddenException('orgId missing from auth context');
    }

    const ent = await this.billing.getEntitlement(orgId);
    if (!ent) {
      throw new ForbiddenException({ code: 'NO_SUBSCRIPTION' });
    }
    if (ent.status === 'canceled' || ent.status === 'incomplete_expired') {
      throw new ForbiddenException({ code: 'CANCELED' });
    }
    if (requires.write && ent.in_grace_period) {
      throw new ForbiddenException({ code: 'PAYMENT_REQUIRED' });
    }
    if (!ent.active && !ent.in_grace_period) {
      // incomplete / paused
      throw new ForbiddenException({ code: 'INACTIVE_SUBSCRIPTION' });
    }
    if (requires.specialty_pack && !ent.specialty_packs.includes(requires.specialty_pack)) {
      throw new ForbiddenException({ code: 'PACK_NOT_LICENSED', pack: requires.specialty_pack });
    }

    // Optional state check: if the route accepts a `state` body field and
    // the tenant has a non-empty entitlement.states list, enforce.
    const body = req.body as { state?: unknown } | undefined;
    const state = typeof body?.state === 'string' ? body.state.toUpperCase() : undefined;
    if (state && ent.states.length > 0 && !ent.states.includes(state)) {
      throw new ForbiddenException({ code: 'STATE_NOT_LICENSED', state });
    }

    // Stash entitlement for downstream handlers.
    (req as Request & { entitlement?: typeof ent }).entitlement = ent;
    return true;
  }
}
