/**
 * InviteController — admin-issue + anonymous-redeem.
 *
 *   POST /v1/admin/invites             (auth, admin role required at app layer)
 *      Body: { user_id, role, ttl_days? }
 *      Returns: { redeem_url, expires_at }
 *
 *   POST /v1/invite/redeem             (anonymous)
 *      Body: { token }
 *      Returns: { org_id, user_id, email, role }
 *
 * The redeem endpoint is the one that anonymous-public callers hit;
 * a class-validator DTO bounds the input shape and rate-limit is
 * applied at the same per-IP token bucket as signup.
 */
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { InviteService } from './invite.service';

export const INVITE_REDEEM_BASE_URL_TOKEN = Symbol('INVITE_REDEEM_BASE_URL');

class IssueDto {
  @IsUUID()
  user_id!: string;

  @IsIn(['employee', 'reviewer', 'admin', 'consultant'])
  role!: 'employee' | 'reviewer' | 'admin' | 'consultant';

  @IsInt()
  @Min(1)
  @Max(30)
  ttl_days?: number;
}

class RedeemDto {
  @IsString()
  @Length(12, 100)
  token!: string;
}

// Per-IP token bucket reused from signup pattern. 10 redeem attempts /
// 60s per IP — generous enough for legitimate retry, tight enough to
// stop credential-stuffing attacks against the prefix index.
const REDEEM_LIMIT = 10;
const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  const slot = buckets.get(ip);
  if (!slot || slot.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (slot.count >= REDEEM_LIMIT) return false;
  slot.count++;
  return true;
}

/** Test-only: reset the in-memory bucket so suites are independent. */
export function _resetInviteRateLimit(): void {
  buckets.clear();
}

@ApiTags('admin')
@Controller('v1/admin/invites')
@UseGuards(AuthGuard)
export class InviteIssueController {
  constructor(
    private readonly invites: InviteService,
    @Optional() @Inject(INVITE_REDEEM_BASE_URL_TOKEN) private readonly baseUrl?: string,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Issue a magic-link invite for an existing app_user' })
  async issue(@Req() req: Request, @Body() body: IssueDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const issuedBy = assertUuid(req.auth?.userId, 'userId');
    const ttlMs = body.ttl_days ? body.ttl_days * 24 * 3600 * 1000 : undefined;
    const { rawToken, expiresAt, tokenId } = await this.invites.issue({
      orgId,
      userId: body.user_id,
      role: body.role,
      ttlMs,
      issuedByUserId: issuedBy,
    });
    const base = this.baseUrl ?? 'https://app.example.com';
    return {
      id: tokenId,
      redeem_url: `${base.replace(/\/$/, '')}/invite/${encodeURIComponent(rawToken)}`,
      expires_at: expiresAt.toISOString(),
    };
  }

  @Get()
  @ApiOperation({ summary: 'List recent invites for the calling tenant' })
  async list(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const rows = await this.invites.listForOrg(orgId);
    return { invites: rows };
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an outstanding invite' })
  async revoke(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const ok = await this.invites.revoke(orgId, id);
    if (!ok) throw new NotFoundException({ code: 'INVITE_NOT_FOUND' });
    return;
  }
}

@ApiTags('invite')
@Controller('v1/invite')
export class InviteRedeemController {
  constructor(private readonly invites: InviteService) {}

  @Post('redeem')
  @ApiOperation({ summary: 'Redeem a magic-link invite. Anonymous + rate-limited.' })
  async redeem(
    @Req() req: Request,
    @Headers('user-agent') _ua: string | undefined,
    @Body() body: RedeemDto,
  ) {
    const ip = (req.ip ?? req.socket?.remoteAddress ?? '').toString();
    if (!rateLimit(ip || 'unknown')) {
      throw new ForbiddenException({ code: 'RATE_LIMITED' });
    }
    return this.invites.redeem(body.token, ip || null);
  }
}
