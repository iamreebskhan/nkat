/**
 * Admin tenant-deletion management — fulfills MSA § 7 ("Customer may
 * request immediate deletion in writing; Company will complete deletion
 * within 30 days").
 *
 *   POST   /v1/admin/tenant/delete            — request deletion
 *   GET    /v1/admin/tenant/delete            — read current request
 *   DELETE /v1/admin/tenant/delete/:id        — cancel a pending request
 *
 * The executor runs daily and processes requests whose
 * earliest_execute_at has passed. The 30-day floor is server-enforced
 * — admins can't shorten it.
 *
 * To request, the admin must type back the exact confirmation phrase
 * `DELETE-TENANT-<orgSlug>` so a misclick on a UI button can't trigger
 * deletion of customer data.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import { earliestExecuteAt, validateConfirmationPhrase } from './tenant-deletion-pure';

class RequestDeletionDto {
  @IsString()
  @MaxLength(200)
  confirmation_phrase!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(180)
  notice_days?: number;

  @IsOptional()
  @IsBoolean()
  retain_audit_log?: boolean;
}

@ApiTags('admin')
@Controller('v1/admin/tenant/delete')
@UseGuards(AuthGuard)
export class TenantDeletionController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Post()
  @ApiOperation({ summary: 'Request deletion of the calling tenant (MSA § 7). 30-day grace.' })
  async request(@Req() req: Request, @Body() body: RequestDeletionDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = assertUuid(req.auth?.userId, 'userId');

    return runWithTenant(this.db, orgId, async (tx) => {
      // Pull org slug for the confirmation-phrase contract.
      const org = await tx
        .selectFrom('org')
        .select(['id', 'slug', 'name'])
        .where('id', '=', orgId)
        .executeTakeFirst();
      if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });

      if (!validateConfirmationPhrase(body.confirmation_phrase, org.slug)) {
        throw new BadRequestException({
          code: 'CONFIRMATION_PHRASE_MISMATCH',
          expected: `DELETE-TENANT-${org.slug}`,
        });
      }

      // Refuse if a non-canceled request already exists.
      const existing = await tx
        .selectFrom('tenant_deletion_request')
        .select(['id', 'status'])
        .where('org_id', '=', orgId)
        .where('status', 'in', ['requested', 'scheduled'])
        .executeTakeFirst();
      if (existing) {
        throw new ConflictException({
          code: 'DELETION_ALREADY_PENDING',
          existing_id: existing.id,
          status: existing.status,
        });
      }

      const earliest = earliestExecuteAt(Date.now(), body.notice_days);
      const inserted = await tx
        .insertInto('tenant_deletion_request')
        .values({
          org_id: orgId,
          earliest_execute_at: earliest,
          confirmation_phrase: body.confirmation_phrase,
          reason: body.reason ?? null,
          retain_audit_log: body.retain_audit_log ?? true,
          requested_by_user_id: userId,
        })
        .returning(['id', 'earliest_execute_at'])
        .executeTakeFirstOrThrow();

      // Audit-log the request — important paper trail.
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'tenant_deletion.request',
          target_type: 'tenant_deletion_request',
          target_id: inserted.id,
          payload: {
            earliest_execute_at: inserted.earliest_execute_at.toISOString(),
            retain_audit_log: body.retain_audit_log ?? true,
            reason: body.reason ?? null,
          },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();

      return {
        id: inserted.id,
        status: 'requested' as const,
        earliest_execute_at: inserted.earliest_execute_at.toISOString(),
        org_slug: org.slug,
      };
    });
  }

  @Get()
  @ApiOperation({ summary: "Read the calling tenant's current deletion request, if any" })
  async current(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const row = await tx
        .selectFrom('tenant_deletion_request')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!row) return { status: 'none' as const };
      return row;
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a pending deletion request (only requested/scheduled state)' })
  async cancel(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = assertUuid(req.auth?.userId, 'userId');
    assertUuid(id, 'id');

    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .updateTable('tenant_deletion_request')
        .set({ status: 'canceled', canceled_at: sql`now()` })
        .where('id', '=', id)
        .where('org_id', '=', orgId)
        .where('status', 'in', ['requested', 'scheduled'])
        .returning('id')
        .executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'DELETION_NOT_PENDING' });

      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'tenant_deletion.cancel',
          target_type: 'tenant_deletion_request',
          target_id: id,
          payload: {},
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();

      return { ok: true };
    });
  }
}
