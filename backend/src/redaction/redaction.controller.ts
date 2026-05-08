/**
 * PHI redaction surface.
 *
 *   POST /v1/redaction/preview   — preview the redactor output (no DB write)
 *   POST /v1/redaction/ingest    — create a client_doc_upload + redaction_event,
 *                                   storing ONLY the redacted text. Originals
 *                                   are never persisted by this path.
 *
 * Both rate-limited per scope `redaction_*`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid, isUuid } from '../common/uuid';
import { RateLimit } from '../common/rate-limit/rate-limit.interceptor';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runWithTenant } from '../database/rls-transaction';
import { RedactionService } from './redaction.service';

class PreviewDto {
  @IsString()
  @MaxLength(1_000_000)
  raw_text!: string;
}

class IngestDto {
  @IsString()
  @MaxLength(1_000_000)
  raw_text!: string;

  @IsString()
  client_id!: string;

  @IsString()
  @MaxLength(255)
  filename!: string;
}

@ApiTags('redaction')
@Controller('v1/redaction')
@UseGuards(AuthGuard)
export class RedactionController {
  constructor(
    private readonly svc: RedactionService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @RateLimit({ limit: 30, refillPerSec: 0.5, scope: 'redaction_preview' })
  @ApiOperation({
    summary: 'Run the PHI redactor over raw text without persisting (UX preview).',
  })
  preview(@Body() body: PreviewDto) {
    const result = this.svc.redact(body.raw_text);
    return {
      redacted: result.redacted,
      category_counts: result.category_counts,
      total_redactions: result.total_redactions,
    };
  }

  @Post('ingest')
  @HttpCode(201)
  @RateLimit({ limit: 10, refillPerSec: 0.1, scope: 'redaction_ingest' })
  @ApiOperation({
    summary:
      'Persist a redacted-only copy of a document as a client_doc_upload. ' +
      'Original raw text is never stored. Returns the upload + redaction_event ids.',
  })
  async ingest(@Req() req: Request, @Body() body: IngestDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    if (!isUuid(body.client_id)) {
      throw new BadRequestException({ code: 'INVALID_CLIENT_ID' });
    }
    return runWithTenant(this.db, orgId, async (tx) => {
      // Verify the client_id is a real client of THIS org (RLS already
      // hides cross-tenant rows, but a 400 is friendlier than empty).
      const client = await tx
        .selectFrom('client_company')
        .select('id')
        .where('id', '=', body.client_id)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!client) {
        throw new BadRequestException({ code: 'CLIENT_NOT_FOUND_IN_ORG' });
      }

      const upload = await tx
        .insertInto('client_doc_upload')
        .values({
          org_id: orgId,
          client_id: body.client_id,
          uploaded_by: userId,
          original_filename: body.filename,
          content_type: 'text/plain',
          byte_size: String(Buffer.byteLength(body.raw_text, 'utf8')),
          raw_storage_uri: null,
          redacted_text: null,
          redaction_summary: {},
          source_document_id: null,
          notes: null,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      const redaction = await this.svc.redactAndPersist(tx, {
        org_id: orgId,
        upload_id: upload.id,
        raw_text: body.raw_text,
        performed_by: userId ?? 'system',
      });

      // Audit-log so SOC 2 can prove the original was never stored.
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'redaction.ingest',
          target_type: 'client_doc_upload',
          target_id: upload.id,
          payload: {
            redaction_event_id: redaction.audit_event_id,
            category_counts: redaction.result.category_counts,
            total_redactions: redaction.result.total_redactions,
          },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();

      return {
        upload_id: upload.id,
        redaction_event_id: redaction.audit_event_id,
        total_redactions: redaction.result.total_redactions,
        category_counts: redaction.result.category_counts,
      };
    });
  }
}
