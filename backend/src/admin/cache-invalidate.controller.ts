/**
 * Admin endpoint to bump the global synthesis-cache version. Use case:
 * a payer rule changed substantially (e.g. NCCI quarterly drop) and we
 * want to roll over cached synthesis results without waiting for the
 * 7-day TTL.
 *
 *   POST /v1/admin/cache/invalidate
 *      Body: { note?: string }
 *      Returns: { version: number }
 *
 * Auth-guarded; the bump is platform-global (not per-tenant), so the
 * actor's user_id is recorded in `system_setting.updated_by_user_id`
 * and an `audit_log` row is written under the calling tenant.
 *
 * Why not a destructive TRUNCATE: bumping the version causes new lookups
 * to populate the cache afresh while old rows naturally TTL out. No
 * thundering herd on cache misses, no DDL lock.
 */
import {
  Body,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { CacheVersionService } from '../synthesis/cache-version.service';

class InvalidateDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

@ApiTags('admin')
@Controller('v1/admin/cache')
@UseGuards(AuthGuard)
export class CacheInvalidateController {
  constructor(
    private readonly cacheVersion: CacheVersionService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  @Post('invalidate')
  @ApiOperation({ summary: 'Bump the global synthesis-cache version (admin only)' })
  async invalidate(@Req() req: Request, @Body() body: InvalidateDto) {
    const userId = assertUuid(req.auth?.userId, 'userId');
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const newVersion = await this.cacheVersion.bump({
      byUserId: userId,
      note: body.note ?? null,
    });
    await this.db
      .insertInto('audit_log')
      .values({
        org_id: orgId,
        user_id: userId,
        action: 'synthesis_cache.invalidate',
        target_type: 'system_setting',
        target_id: null,
        payload: { new_version: newVersion, note: body.note ?? null },
        ip_address: (req.ip ?? null) as string | null,
        user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
      })
      .execute();
    return { version: newVersion };
  }
}
