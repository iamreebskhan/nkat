/**
 * Webhook subscription CRUD — admin-tier endpoints. RLS-scoped to the
 * caller's org via runWithTenant in the service layer.
 *
 *   POST   /v1/admin/webhook-subscriptions      — create
 *   GET    /v1/admin/webhook-subscriptions      — list (this tenant)
 *   POST   /v1/admin/webhook-subscriptions/:id/pause   — pause
 *   POST   /v1/admin/webhook-subscriptions/:id/resume  — resume
 *   DELETE /v1/admin/webhook-subscriptions/:id  — disable
 */
import {
  Body,
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
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Idempotent } from '../common/idempotency/idempotency.interceptor';
import { assertUuid, isUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import type { WebhookEventType } from '../database/schema.types';

const VALID_EVENT_TYPES: WebhookEventType[] = [
  'alert.created',
  'rulebook.finalized',
  'rule.changed',
  'rule.disputed',
  'dispute.resolved',
  'attestation.expiring',
  'extraction.candidate.queued',
];

class CreateSubscriptionDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(VALID_EVENT_TYPES, { each: true })
  event_types!: WebhookEventType[];

  /** Optional caller-supplied secret; if omitted we generate a 32-byte hex. */
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  signing_secret?: string;
}

@ApiTags('admin')
@Controller('v1/admin/webhook-subscriptions')
@UseGuards(AuthGuard)
export class WebhookSubscriptionController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Create a webhook subscription for the caller tenant' })
  async create(@Req() req: Request, @Body() body: CreateSubscriptionDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const secret = body.signing_secret ?? randomBytes(32).toString('hex');
    const inserted = await runWithTenant(this.db, orgId, async (tx) =>
      tx
        .insertInto('webhook_subscription')
        .values({
          org_id: orgId,
          url: body.url,
          signing_secret: secret,
          event_types: body.event_types,
        })
        .returning(['id', 'url', 'event_types', 'status', 'created_at'])
        .executeTakeFirstOrThrow(),
    );
    return { ...inserted, signing_secret: secret };
  }

  @Get()
  @ApiOperation({ summary: 'List webhook subscriptions for this tenant' })
  async list(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return runReadOnlyWithTenant(this.db, orgId, async (tx) =>
      tx
        .selectFrom('webhook_subscription')
        .select([
          'id',
          'url',
          'event_types',
          'status',
          'last_success_at',
          'last_failure_at',
          'consecutive_failures',
          'created_at',
        ])
        .orderBy('created_at', 'desc')
        .execute(),
    );
  }

  @Post(':id/pause')
  @ApiOperation({ summary: 'Pause a subscription' })
  async pause(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    if (!isUuid(id)) throw new NotFoundException();
    return this.setStatus(orgId, id, 'paused');
  }

  @Post(':id/resume')
  @ApiOperation({ summary: 'Resume a paused subscription' })
  async resume(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    if (!isUuid(id)) throw new NotFoundException();
    return this.setStatus(orgId, id, 'active');
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Disable a subscription (soft delete; deliveries already in flight finish or dead-letter)',
  })
  async remove(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    if (!isUuid(id)) throw new NotFoundException();
    return this.setStatus(orgId, id, 'disabled');
  }

  private async setStatus(
    orgId: string,
    id: string,
    status: 'active' | 'paused' | 'disabled',
  ): Promise<{ id: string; status: string }> {
    return runWithTenant(this.db, orgId, async (tx) => {
      const result = await tx
        .updateTable('webhook_subscription')
        .set({ status })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0) === 0) throw new NotFoundException();
      return { id, status };
    });
  }
}
