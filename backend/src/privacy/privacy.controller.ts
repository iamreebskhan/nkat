/**
 * Consumer-privacy public surface.
 *
 *   GET  /v1/privacy/notices/:state                 — public; fetches notices for a state
 *   POST /v1/privacy/consent                        — auth required; record an acceptance
 *   POST /v1/privacy/dsar                           — public + auth-optional; file a DSAR
 *   GET  /v1/privacy/dsar                           — auth required; tenant-side admin list
 *   PATCH /v1/privacy/dsar/:id                      — auth required; tenant updates status
 */
import {
  Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength,
} from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import type { DsarRegime, DsarRequestType, DsarStatus, PrivacyRegime } from '../database/schema.types';
import { noticesForState } from './notices';

const PRIVACY_REGIMES: PrivacyRegime[] = [
  'wmhmda', 'ccpa', 'cpa_co', 'tdpsa_tx', 'vcdpa_va',
  'ab3030_ai', 'sb24_205_ai_co', 'general',
];
const DSAR_REGIMES: DsarRegime[] = [
  'wmhmda', 'ccpa', 'cpa_co', 'tdpsa_tx', 'vcdpa_va', 'ctdpa_ct', 'utah_ucpa', 'general',
];
const DSAR_REQUEST_TYPES: DsarRequestType[] = [
  'access', 'deletion', 'portability', 'correction',
  'opt_out_sale', 'opt_out_targeted_advertising', 'limit_sensitive_use',
];

class ConsentDto {
  @IsIn(PRIVACY_REGIMES) regime!: PrivacyRegime;
  @IsString() @MaxLength(64) notice_version!: string;
  @IsBoolean() granted!: boolean;
  @IsOptional() @IsString() @MaxLength(200) subject_external_id?: string;
}

class DsarSubmitDto {
  @IsIn(DSAR_REGIMES) regime!: DsarRegime;
  @IsIn(DSAR_REQUEST_TYPES) request_type!: DsarRequestType;
  @IsOptional() @IsEmail() subject_email?: string;
  @IsOptional() @IsString() @MaxLength(200) subject_name?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class DsarUpdateDto {
  @IsIn(['received', 'verified', 'fulfilled', 'rejected', 'expired'] as const)
  status!: DsarStatus;
  @IsOptional() @IsString() @MaxLength(2000) rejection_reason?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

@ApiTags('privacy')
@Controller('v1/privacy')
export class PrivacyController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('notices/:state')
  @ApiOperation({ summary: 'Return privacy + AI notices applicable to a state' })
  notices(@Param('state') state: string) {
    if (!/^[A-Za-z]{2}$/.test(state)) {
      throw new NotFoundException({ code: 'INVALID_STATE' });
    }
    return { state: state.toUpperCase(), notices: noticesForState(state) };
  }

  @Post('consent')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Record a consent decision for a privacy notice' })
  async consent(@Req() req: Request, @Body() body: ConsentDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .insertInto('privacy_consent')
        .values({
          org_id: orgId,
          user_id: userId,
          subject_external_id: body.subject_external_id ?? null,
          regime: body.regime,
          notice_version: body.notice_version,
          granted: body.granted,
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .returning(['id', 'granted_at'])
        .executeTakeFirstOrThrow();
      return r;
    });
  }

  @Post('dsar')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'File a Data Subject Access/Deletion Request. 45-day clock starts at received_at.',
  })
  async fileDsar(@Req() req: Request, @Body() body: DsarSubmitDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    return runWithTenant(this.db, orgId, async (tx) => {
      const due = new Date(Date.now() + 45 * 86_400_000);
      const r = await tx
        .insertInto('dsar_request')
        .values({
          org_id: orgId,
          user_id: userId,
          subject_email: body.subject_email ?? null,
          subject_name: body.subject_name ?? null,
          regime: body.regime,
          request_type: body.request_type,
          due_at: due,
          notes: body.notes ?? null,
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .returning(['id', 'due_at', 'received_at'])
        .executeTakeFirstOrThrow();
      // Audit-log the receipt for the SLA clock + SOC 2 evidence.
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'privacy.dsar_received',
          target_type: 'dsar_request',
          target_id: r.id,
          payload: {
            regime: body.regime,
            request_type: body.request_type,
            due_at: r.due_at.toISOString(),
          },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();
      return r;
    });
  }

  @Get('dsar')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Tenant admin: list DSAR requests' })
  async listDsar(@Req() req: Request, @Query('status') status?: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      let q = tx
        .selectFrom('dsar_request')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('received_at', 'desc')
        .limit(500);
      if (status && ['received', 'verified', 'fulfilled', 'rejected', 'expired'].includes(status)) {
        q = q.where('status', '=', status as DsarStatus);
      }
      const items = await q.execute();
      return { items };
    });
  }

  @Patch('dsar/:id')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Tenant admin: update a DSAR\'s status' })
  async updateDsar(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: DsarUpdateDto,
  ) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    assertUuid(id, 'id');
    return runWithTenant(this.db, orgId, async (tx) => {
      const updates: Record<string, unknown> = { status: body.status };
      if (body.status === 'fulfilled') updates.fulfilled_at = sql`now()`;
      if (body.rejection_reason !== undefined) updates.rejection_reason = body.rejection_reason;
      if (body.notes !== undefined) updates.notes = body.notes;
      const r = await tx
        .updateTable('dsar_request')
        .set(updates)
        .where('id', '=', id)
        .where('org_id', '=', orgId)
        .returning(['id', 'status', 'fulfilled_at'])
        .executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'DSAR_NOT_FOUND' });
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'privacy.dsar_status_change',
          target_type: 'dsar_request',
          target_id: id,
          payload: { status: body.status, rejection_reason: body.rejection_reason ?? null },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();
      return r;
    });
  }
}
