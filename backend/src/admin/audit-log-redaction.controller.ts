/**
 * Admin audit-log redaction surface.
 *
 *   POST /v1/admin/audit-log/:id/redact
 *
 * Body:
 *   { type: 'payload_scrub' | 'payload_remove', reason: string }
 *
 * Caller must be an admin in the audit_log row's org. RLS enforces
 * cross-tenant access (the row simply won't be visible).
 *
 * Refuses to redact rows whose action is `audit_log.redact` — that
 * meta-row records the redaction itself and must remain immutable.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';
import {
  AuditLogRedactionService,
  type RedactionType,
} from './audit-log-redaction.service';

class RedactDto {
  @IsIn(['payload_scrub', 'payload_remove'])
  type!: RedactionType;

  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  reason!: string;
}

@ApiTags('admin')
@Controller('v1/admin/audit-log')
@UseGuards(AuthGuard)
export class AuditLogRedactionController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly svc: AuditLogRedactionService,
  ) {}

  @Post(':id/redact')
  @ApiOperation({
    summary:
      'Scrub or remove a single audit_log row\'s payload. Records a hash + meta-audit row.',
  })
  async redact(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: RedactDto,
  ) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = assertUuid(req.auth?.userId, 'userId');
    assertUuid(id, 'id');

    // Block redaction of meta-audit rows: those record the redaction
    // event itself. Letting them be scrubbed would erase the audit
    // trail the redaction was supposed to preserve.
    const action = await runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const row = await tx
        .selectFrom('audit_log')
        .select('action')
        .where('id', '=', id)
        .executeTakeFirst();
      return row?.action ?? null;
    });
    if (action === 'audit_log.redact') {
      throw new BadRequestException({
        code: 'CANNOT_REDACT_META_AUDIT',
        message: 'Meta-audit rows recording redaction events are immutable.',
      });
    }

    return this.svc.redact({
      orgId,
      auditLogId: id,
      redactedByUserId: userId,
      reason: body.reason,
      type: body.type,
    });
  }
}
