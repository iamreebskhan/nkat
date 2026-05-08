/**
 * CMS Final Rules ingestion — Mark's "S3 drop folder" model.
 *
 *   POST /v1/admin/final-rules        — upload PDF + metadata
 *   GET  /v1/admin/final-rules        — list (per-tenant view of recent uploads)
 *
 * Flow:
 *   1. Analyst downloads a Final Rule PDF from federalregister.gov / cms.gov.
 *   2. Drops it via this endpoint (multipart-equivalent — base64 in JSON
 *      so we don't need multer).
 *   3. We compute SHA-256, dedupe against existing source_document rows
 *      with the same hash, persist to disk-or-S3, insert a
 *      source_document row with type='cms_final_rule'.
 *   4. The downstream extractor (existing extraction_queue) picks
 *      candidate rules out of the document at its own pace.
 *
 * 50 MB cap on the encoded body (CMS Final Rules are 5–25 MB).
 *
 * Per-tenant audit-log entry on every upload — SOC 2 evidence that the
 * analyst's action is traceable.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid, isUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import type { SourceDocumentType } from '../database/schema.types';
import { LocalDiskStorage, decodeBase64Bounded } from './storage';

const MAX_BYTES = 50 * 1024 * 1024; // 50MB

const RULE_TYPES = [
  'cms_final_rule',
  'mln_article',
  'cms_pfs',
  'state_medicaid_manual',
] as const satisfies readonly SourceDocumentType[];

class UploadDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MinLength(8)
  // Validation handled by decodeBase64Bounded (size + format).
  content_base64!: string;

  @IsString()
  @MaxLength(500)
  title!: string;

  @IsIn(RULE_TYPES as unknown as string[])
  document_type!: (typeof RULE_TYPES)[number];

  @IsOptional()
  @IsDateString()
  effective_date?: string;

  @IsOptional()
  @IsString()
  payer_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  content_type?: string;
}

class ListQueryDto {
  @IsOptional()
  @IsString()
  document_type?: string;
}

interface UploadResp {
  source_document_id: string;
  storage_uri: string;
  sha256: string;
  bytes: number;
  duplicate: boolean;
}

@ApiTags('admin')
@Controller('v1/admin/final-rules')
@UseGuards(AuthGuard)
export class FinalRulesController {
  private readonly log = new Logger(FinalRulesController.name);
  private readonly storage = new LocalDiskStorage();

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Post()
  @ApiOperation({
    summary:
      'Upload a CMS Final Rule (or MLN article / state Medicaid manual) PDF as base64 JSON. ' +
      'Persists the file + a source_document row; downstream extractor picks up new rows on its own.',
  })
  async upload(@Req() req: Request, @Body() body: UploadDto): Promise<UploadResp> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;

    if (body.payer_id && !isUuid(body.payer_id)) {
      throw new BadRequestException({ code: 'INVALID_PAYER_ID' });
    }

    let buf: Buffer;
    try {
      buf = decodeBase64Bounded(body.content_base64, MAX_BYTES);
    } catch (e) {
      throw new BadRequestException({
        code: 'BAD_PAYLOAD',
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const stored = await this.storage.put({
      orgId,
      filename: body.filename,
      contentType: body.content_type ?? 'application/pdf',
      data: buf,
    });

    // source_document is GLOBAL (no org_id, no RLS) — Final Rules apply
    // across all tenants, so dedupe is content-hash-based across the
    // entire platform. We still audit-log per-tenant who did the upload.
    let duplicate = false;
    let sourceDocId: string;
    {
      const existing = await this.db
        .selectFrom('source_document')
        .select('id')
        .where('content_hash', '=', stored.sha256)
        .where('document_type', '=', body.document_type)
        .executeTakeFirst();
      if (existing) {
        duplicate = true;
        sourceDocId = existing.id;
      } else {
        const inserted = await this.db
          .insertInto('source_document')
          .values({
            payer_id: body.payer_id ?? null,
            url: body.url ?? `local-upload://${stored.sha256}`,
            document_type: body.document_type,
            title: body.title,
            effective_date: body.effective_date ? new Date(body.effective_date) : null,
            retrieved_at: new Date(),
            content_hash: stored.sha256,
            storage_uri: stored.storage_uri,
            cms_license_token_used: false,
            source_metadata: {
              uploaded_by_org_id: orgId,
              uploaded_by_user_id: userId,
              filename: body.filename,
              bytes: stored.bytes,
            },
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        sourceDocId = inserted.id;
      }
    }

    // Audit-log per tenant — never logs the bytes, just the hash + sizes.
    await runWithTenant(this.db, orgId, async (tx) => {
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'final_rule.upload',
          target_type: 'source_document',
          target_id: sourceDocId,
          payload: {
            document_type: body.document_type,
            sha256: stored.sha256,
            bytes: stored.bytes,
            duplicate,
            filename: body.filename,
            title: body.title,
          },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();
    });

    this.log.log(
      `org=${orgId} uploaded ${body.document_type} sha=${stored.sha256.slice(0, 12)} ` +
        `bytes=${stored.bytes} dup=${duplicate}`,
    );
    return {
      source_document_id: sourceDocId,
      storage_uri: stored.storage_uri,
      sha256: stored.sha256,
      bytes: stored.bytes,
      duplicate,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List recent Final Rules / regulatory uploads (limited to last 200)' })
  async list(@Req() req: Request, @Query() q: ListQueryDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');

    // Surface the audit-log entries this tenant created. The
    // source_document table is global; we don't leak cross-tenant
    // upload activity. Each row joins to the doc by target_id.
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      let logQ = tx
        .selectFrom('audit_log as a')
        .innerJoin('source_document as d', 'd.id', 'a.target_id')
        .select([
          'd.id as id',
          'd.title',
          'd.document_type',
          'd.effective_date',
          'd.retrieved_at',
          'd.content_hash',
          'd.storage_uri',
          'a.user_id as uploaded_by_user_id',
          'a.occurred_at',
          sql<Record<string, unknown>>`a.payload`.as('payload'),
        ])
        .where('a.org_id', '=', orgId)
        .where('a.action', '=', 'final_rule.upload')
        .orderBy('a.occurred_at', 'desc')
        .limit(200);
      if (q.document_type && (RULE_TYPES as readonly string[]).includes(q.document_type)) {
        logQ = logQ.where('d.document_type', '=', q.document_type as SourceDocumentType);
      }
      const rows = await logQ.execute();
      return { items: rows };
    });
  }
}
