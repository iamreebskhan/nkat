import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { isUuid } from '../common/uuid';
import { ExtractionQueueService } from './extraction-queue.service';

class NextBatchQuery {
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 10;
}

class AcceptDto {
  @IsEmail() analyst_email!: string;
  @IsOptional() @IsString() rationale?: string;
  @IsOptional() @IsObject() attestation_call?: Record<string, unknown>;
}

class RejectDto {
  @IsEmail() analyst_email!: string;
  @IsString() rationale!: string;
}

class EditDto {
  @IsEmail() analyst_email!: string;
  @IsObject() edited_value!: Record<string, unknown>;
  @IsIn(['covered', 'not_covered', 'varies', 'unknown'])
  edited_coverage_status!: 'covered' | 'not_covered' | 'varies' | 'unknown';
  @IsNumber() @Min(0) @Max(1) edited_confidence!: number;
  @IsOptional() @IsString() rationale?: string;
}

class ClaimDto {
  @IsEmail() analyst_email!: string;
}

@ApiTags('admin')
@Controller('v1/admin/extraction-queue')
@UseGuards(AuthGuard)
export class ExtractionQueueController {
  constructor(@Inject(ExtractionQueueService) private readonly svc: ExtractionQueueService) {}

  @Get('next')
  @ApiOperation({ summary: 'Pull next-priority unclaimed candidates' })
  async next(@Req() _req: Request, @Query() q: NextBatchQuery) {
    return { items: await this.svc.nextBatch(q.limit) };
  }

  @Post(':id/claim')
  @ApiOperation({ summary: 'Atomically claim a candidate (queued → claimed)' })
  async claim(@Param('id') id: string, @Body() body: ClaimDto) {
    const ok = await this.svc.claim(uuidOrThrow(id), body.analyst_email);
    return { claimed: ok };
  }

  @Post(':id/accept')
  @ApiOperation({ summary: 'Accept candidate and insert payer_rule' })
  async accept(@Param('id') id: string, @Body() body: AcceptDto) {
    const ruleId = await this.svc.accept(
      uuidOrThrow(id),
      body.analyst_email,
      body.rationale,
      body.attestation_call,
    );
    return { rule_id: ruleId };
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject candidate' })
  async reject(@Param('id') id: string, @Body() body: RejectDto) {
    await this.svc.reject(uuidOrThrow(id), body.analyst_email, body.rationale);
    return { ok: true };
  }

  @Post(':id/edit')
  @ApiOperation({ summary: 'Accept with edits and insert edited payer_rule' })
  async edit(@Param('id') id: string, @Body() body: EditDto) {
    const ruleId = await this.svc.edit(
      uuidOrThrow(id),
      body.analyst_email,
      {
        edited_value: body.edited_value,
        edited_coverage_status: body.edited_coverage_status,
        edited_confidence: body.edited_confidence,
      },
      body.rationale,
    );
    return { rule_id: ruleId };
  }
}

function uuidOrThrow(id: string): string {
  if (!isUuid(id)) {
    throw new Error('id must be a UUID');
  }
  return id;
}
