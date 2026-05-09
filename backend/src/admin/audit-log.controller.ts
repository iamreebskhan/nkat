/**
 * Audit-log search — for SOC 2 evidence + customer admin investigations.
 *
 * Tenant-scoped via runReadOnlyWithTenant. Filters: action, target_type,
 * user_id, occurred_at range. Pagination: keyset on occurred_at DESC.
 */
import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';

class AuditQuery {
  @IsOptional() @IsString() @MaxLength(64) action?: string;
  @IsOptional() @IsString() @MaxLength(64) target_type?: string;
  @IsOptional() @IsString() @MaxLength(64) user_id?: string;
  @IsOptional() @IsDateString() since?: string;
  @IsOptional() @IsDateString() until?: string;
  @IsOptional() @IsString() cursor?: string; // ISO timestamp of the last seen row's occurred_at
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@ApiTags('admin')
@Controller('v1/admin/audit-log')
@UseGuards(AuthGuard)
export class AuditLogController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'Search this tenant audit log (paginated, keyset)' })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'target_type', required: false })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({
    name: 'since',
    required: false,
    description: 'ISO timestamp lower bound (inclusive)',
  })
  @ApiQuery({
    name: 'until',
    required: false,
    description: 'ISO timestamp upper bound (exclusive)',
  })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async search(@Req() req: Request, @Query() q: AuditQuery) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const limit = q.limit ?? 100;

    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      let query = tx
        .selectFrom('audit_log')
        .select([
          'id',
          'user_id',
          'action',
          'target_type',
          'target_id',
          'payload',
          'ip_address',
          'user_agent',
          'occurred_at',
        ])
        .orderBy('occurred_at', 'desc')
        .limit(limit + 1);

      if (q.action) query = query.where('action', '=', q.action);
      if (q.target_type) query = query.where('target_type', '=', q.target_type);
      if (q.user_id) query = query.where('user_id', '=', q.user_id);
      if (q.since) query = query.where('occurred_at', '>=', new Date(q.since));
      if (q.until) query = query.where('occurred_at', '<', new Date(q.until));
      if (q.cursor) query = query.where('occurred_at', '<', new Date(q.cursor));

      const rows = await query.execute();
      const hasMore = rows.length > limit;
      const trimmed = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && trimmed.length > 0
          ? trimmed[trimmed.length - 1].occurred_at.toISOString()
          : null;
      return { items: trimmed, next_cursor: nextCursor };
    });
  }
}
