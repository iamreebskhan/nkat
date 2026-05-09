/**
 * SignupController — public, anonymous endpoint for self-serve signups.
 *
 *   POST /v1/signup/start
 *
 * Body validated by class-validator. The endpoint is rate-limited at the
 * Nest layer (in-memory token bucket per IP) to make casual abuse
 * expensive without requiring Redis. For real abuse the WAF in front of
 * the ALB does the heavier lifting; this is the application-level
 * defense-in-depth.
 */
import { Body, Controller, ForbiddenException, Headers, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { ALL_SPECIALTY_PACKS, type SpecialtyPack } from '../billing/billing-types';
import { SignupService } from './signup.service';

class SignupStartDto {
  @IsString()
  @Length(2, 200)
  company_name!: string;

  @IsEmail()
  @MaxLength(254)
  admin_email!: string;

  @IsIn(['solo', 'team', 'org'])
  tier!: 'solo' | 'team' | 'org';

  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity!: number;

  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  success_url!: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  cancel_url!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @Length(2, 2, { each: true })
  states?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_SPECIALTY_PACKS as readonly string[], { each: true })
  specialty_packs?: SpecialtyPack[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(14)
  trial_days?: number;
}

// In-memory token bucket. Per-IP, 5 starts / 60s. The map is bounded
// by an LRU-ish eviction every minute. Replace with Redis when we
// horizontally scale beyond one ECS task.
const RATE_LIMIT_PER_IP = 5;
const RATE_WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) {
    // Coarse eviction to keep memory bounded.
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  const slot = buckets.get(ip);
  if (!slot || slot.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (slot.count >= RATE_LIMIT_PER_IP) return false;
  slot.count++;
  return true;
}

/** Test-only: reset the in-memory bucket so suites are independent. */
export function _resetSignupRateLimit(): void {
  buckets.clear();
}

@ApiTags('signup')
@Controller('v1/signup')
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Post('start')
  @ApiOperation({ summary: 'Start a self-serve signup. Returns a Stripe Checkout URL.' })
  async start(
    @Req() req: Request,
    @Headers('user-agent') ua: string | undefined,
    @Body() body: SignupStartDto,
  ) {
    const ip = (req.ip ?? req.socket?.remoteAddress ?? '').toString();
    if (!rateLimit(ip || 'unknown')) {
      throw new ForbiddenException({ code: 'RATE_LIMITED' });
    }
    const r = await this.signup.start({
      company_name: body.company_name,
      admin_email: body.admin_email,
      tier: body.tier,
      quantity: body.quantity,
      success_url: body.success_url,
      cancel_url: body.cancel_url,
      states: body.states,
      specialty_packs: body.specialty_packs,
      trial_days: body.trial_days,
      source_ip: ip || null,
      source_user_agent: ua ?? null,
    });
    return {
      checkout_url: r.checkout_url,
      org_id: r.org_id,
      signup_attempt_id: r.signup_attempt_id,
      admin_invite_token: r.admin_invite_token,
      admin_invite_expires_at: r.admin_invite_expires_at,
    };
  }
}
