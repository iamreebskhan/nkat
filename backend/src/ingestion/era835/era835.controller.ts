import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import { runWithTenant } from '../../database/rls-transaction';
import { assertUuid } from '../../common/uuid';
import { Era835Ingestor, type IngestionReport } from './ingestor';
import { parseEra835 } from './parser';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB; an 835 is line-based EDI text.

class UploadDto {
  @IsString()
  @MaxLength(MAX_BYTES)
  body!: string;

  @IsString()
  @MaxLength(64)
  client_id!: string;

  @IsString()
  @MaxLength(2048)
  source_file_uri?: string;
}

@ApiTags('era835')
@Controller('v1/era835')
@UseGuards(AuthGuard)
export class Era835Controller {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ingestor: Era835Ingestor,
  ) {}

  @Post('upload')
  @ApiOperation({
    summary: 'Upload a parsed 835 ERA file and persist it to denial intelligence',
  })
  async upload(
    @Req() req: Request,
    @Body() body: UploadDto,
  ): Promise<IngestionReport & { request_id: string }> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(body.client_id, 'client_id');
    const parsed = parseEra835(body.body);

    const report = await runWithTenant(this.db, orgId, (tx) =>
      this.ingestor.ingest(tx, parsed, {
        org_id: orgId,
        client_id: body.client_id,
        ...(body.source_file_uri ? { source_file_uri: body.source_file_uri } : {}),
      }),
    );

    return { ...report, request_id: cryptoRandomId() };
  }
}

function cryptoRandomId(): string {
  // Cheap request id; for prod we'll inject a request-context id via middleware.
  return Math.random().toString(36).slice(2, 12);
}
