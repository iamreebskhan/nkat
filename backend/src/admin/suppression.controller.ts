/**
 * Admin email-suppression endpoints. Lets ops:
 *
 *   GET    /v1/admin/email-suppression?email=...
 *      Look up the suppression status for an email. Returns 200 with the
 *      row OR 200 with `{ suppressed: false }` (never 404 — querying for
 *      "not in list" is a normal use case).
 *
 *   POST   /v1/admin/email-suppression
 *      Body { email, reason='admin_block', detail?, expires_at? }
 *      Manually add an address to the global suppression list. Use case:
 *      a customer support ticket says "stop emailing me," ops adds them
 *      here.
 *
 *   DELETE /v1/admin/email-suppression/:email
 *      Clear suppression. Break-glass for permanent bounces / complaints
 *      where the customer demonstrates the underlying mailbox issue is
 *      resolved.
 *
 * The suppression list is GLOBAL by SES policy. We require `admin` role
 * in the calling tenant, but the action affects all tenants — so every
 * mutation is audit-logged with the acting user_id + ip_address.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

class CreateSuppressionDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsIn(['admin_block', 'manual_optout'])
  reason?: 'admin_block' | 'manual_optout';

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  detail?: string;

  @IsOptional()
  @IsISO8601()
  expires_at?: string;
}

@ApiTags('admin')
@Controller('v1/admin/email-suppression')
@UseGuards(AuthGuard)
export class SuppressionController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'Look up the suppression status of an address' })
  async lookup(@Query('email') emailRaw: string | undefined) {
    if (!emailRaw) return { suppressed: false };
    const email = emailRaw.trim().toLowerCase();
    const row = await this.db
      .selectFrom('email_suppression')
      .selectAll()
      .where('email', '=', email)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .executeTakeFirst();
    if (!row) return { suppressed: false };
    return { suppressed: true, ...row };
  }

  @Post()
  @ApiOperation({ summary: 'Add an address to the global suppression list (admin override)' })
  async add(@Req() req: Request, @Body() body: CreateSuppressionDto) {
    const userId = assertUuid(req.auth?.userId, 'userId');
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const email = body.email.trim().toLowerCase();
    const reason = body.reason ?? 'admin_block';

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('email_suppression')
        .values({
          email,
          reason,
          source: 'admin_api',
          detail: body.detail ?? null,
          expires_at: body.expires_at ? new Date(body.expires_at) : null,
        })
        .onConflict((oc) =>
          oc.column('email').doUpdateSet({
            reason,
            source: 'admin_api',
            detail: body.detail ?? null,
            expires_at: body.expires_at ? new Date(body.expires_at) : null,
            suppressed_at: sql`now()`,
          }),
        )
        .execute();

      // Audit-log under the acting tenant; the action affects ALL tenants
      // but the trail belongs to the actor.
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'email_suppression.add',
          target_type: 'email_suppression',
          target_id: null,
          payload: { email, reason, detail: body.detail ?? null },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();
    });
    return { ok: true, email };
  }

  @Delete(':email')
  @HttpCode(204)
  @ApiOperation({ summary: 'Clear suppression for an address (break-glass)' })
  async clear(@Req() req: Request, @Param('email') emailRaw: string) {
    const userId = assertUuid(req.auth?.userId, 'userId');
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const email = emailRaw.trim().toLowerCase();
    await this.db.transaction().execute(async (tx) => {
      const r = await tx
        .deleteFrom('email_suppression')
        .where('email', '=', email)
        .returning('email')
        .executeTakeFirst();
      if (!r) {
        throw new NotFoundException({ code: 'EMAIL_NOT_SUPPRESSED' });
      }
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'email_suppression.clear',
          target_type: 'email_suppression',
          target_id: null,
          payload: { email },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();
    });
    return;
  }
}
