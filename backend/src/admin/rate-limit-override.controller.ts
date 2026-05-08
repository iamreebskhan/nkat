/**
 * Per-tenant rate-limit override admin surface.
 *
 *   GET    /v1/admin/rate-limit/overrides         — list calling tenant's overrides
 *   PUT    /v1/admin/rate-limit/overrides/:scope  — upsert
 *   DELETE /v1/admin/rate-limit/overrides/:scope  — remove
 *
 * Limits are clamped server-side (1..1_000_000) and the OverrideResolver
 * is force-refreshed after every write so the change is live within the
 * same request.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  IsDateString,
} from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import { OVERRIDE_RESOLVER_TOKEN } from '../common/rate-limit/tokens';
import type { OverrideResolver } from '../common/rate-limit/override-resolver';

const VALID_SCOPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class UpsertOverrideDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  limit!: number;

  @IsNumber()
  @Min(0)
  @Max(100_000)
  refillPerSec!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

@ApiTags('admin')
@Controller('v1/admin/rate-limit/overrides')
@UseGuards(AuthGuard)
export class RateLimitOverrideController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(OVERRIDE_RESOLVER_TOKEN) private readonly resolver: OverrideResolver,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List active overrides for the calling tenant' })
  async list(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectFrom('rate_limit_override')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('scope', 'asc')
        .execute();
      return { items: rows };
    });
  }

  @Put(':scope')
  @ApiOperation({ summary: 'Upsert an override for one scope' })
  async upsert(
    @Req() req: Request,
    @Param('scope') scope: string,
    @Body() body: UpsertOverrideDto,
  ) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = assertUuid(req.auth?.userId, 'userId');

    if (!VALID_SCOPE.test(scope)) {
      throw new NotFoundException({ code: 'INVALID_SCOPE' });
    }

    return runWithTenant(this.db, orgId, async (tx) => {
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      const row = await tx
        .insertInto('rate_limit_override')
        .values({
          org_id: orgId,
          scope,
          limit: body.limit,
          refill_per_sec: String(body.refillPerSec),
          reason: body.reason ?? null,
          set_by_user_id: userId,
          expires_at: expiresAt,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'scope']).doUpdateSet({
            limit: body.limit,
            refill_per_sec: String(body.refillPerSec),
            reason: body.reason ?? null,
            set_by_user_id: userId,
            expires_at: expiresAt,
            updated_at: sql`now()`,
          }),
        )
        .returning(['org_id', 'scope', 'limit', 'refill_per_sec', 'expires_at'])
        .executeTakeFirstOrThrow();

      // Audit-log the change for SOC 2 + HIPAA evidentiary trail.
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'rate_limit_override.upsert',
          target_type: 'rate_limit_override',
          target_id: scope,
          payload: {
            limit: body.limit,
            refill_per_sec: body.refillPerSec,
            reason: body.reason ?? null,
            expires_at: expiresAt?.toISOString() ?? null,
          },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();

      // Force a resolver refresh so the new override is effective on
      // the very next request — without waiting for the 30s timer tick.
      await this.resolver.refresh().catch(() => {});

      return row;
    });
  }

  @Delete(':scope')
  @ApiOperation({ summary: 'Remove an override' })
  async remove(@Req() req: Request, @Param('scope') scope: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = assertUuid(req.auth?.userId, 'userId');

    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .deleteFrom('rate_limit_override')
        .where('org_id', '=', orgId)
        .where('scope', '=', scope)
        .returning(['scope'])
        .executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'OVERRIDE_NOT_FOUND' });

      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'rate_limit_override.delete',
          target_type: 'rate_limit_override',
          target_id: scope,
          payload: {},
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();

      await this.resolver.refresh().catch(() => {});
      return { ok: true };
    });
  }
}
