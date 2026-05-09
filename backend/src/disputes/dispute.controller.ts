import { Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DisputeService } from './dispute.service';
import type { CoverageStatus, PayerRuleAttribute } from '../database/schema.types';

class SubmitDto {
  @IsOptional() @IsString() payer_rule_id?: string;
  @IsString() payer_id!: string;
  @IsString() state!: string;
  @IsString() product_line!: string;
  @IsString() code!: string;
  @IsString() attribute!: PayerRuleAttribute;
  @IsObject() customer_assertion!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(2048) evidence_url?: string;
  @IsOptional() @IsString() @MaxLength(2000) customer_notes?: string;
}

class ResolveRightDto {
  @IsString() @MaxLength(2000) resolution_notes!: string;
}

class ResolveWrongDto {
  @IsEmail() analyst_email!: string;
  @IsObject() proposed_value!: Record<string, unknown>;
  @IsIn(['covered', 'not_covered', 'varies', 'unknown'])
  proposed_coverage_status!: CoverageStatus;
  @IsNumber() @Min(0) @Max(1) proposed_confidence!: number;
  @IsDateString() proposed_effective_date!: string;
  @IsString() source_doc_id!: string;
  @IsOptional() @IsString() source_quote?: string;
  @IsOptional() @IsString() @MaxLength(2000) resolution_notes?: string;
}

@ApiTags('disputes')
@Controller('v1/disputes')
@UseGuards(AuthGuard)
export class DisputeController {
  constructor(@Inject(DisputeService) private readonly svc: DisputeService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a "this rule is wrong" dispute' })
  async submit(@Req() req: Request, @Body() body: SubmitDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    const id = await this.svc.submit({
      org_id: orgId,
      user_id: userId,
      ...(body.payer_rule_id ? { payer_rule_id: body.payer_rule_id } : {}),
      payer_id: body.payer_id,
      state: body.state,
      product_line: body.product_line,
      code: body.code,
      attribute: body.attribute,
      customer_assertion: body.customer_assertion,
      ...(body.evidence_url ? { evidence_url: body.evidence_url } : {}),
      ...(body.customer_notes ? { customer_notes: body.customer_notes } : {}),
    });
    return { id };
  }

  @Post(':id/resolve-right')
  @ApiOperation({ summary: 'Analyst confirms our rule is correct' })
  async resolveRight(@Req() req: Request, @Param('id') id: string, @Body() body: ResolveRightDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'dispute_id');
    await this.svc.resolveRight(orgId, id, body.resolution_notes);
    return { ok: true };
  }

  @Post(':id/resolve-wrong')
  @ApiOperation({ summary: 'Analyst confirms our rule is wrong; spawns extraction_candidate' })
  async resolveWrong(@Req() req: Request, @Param('id') id: string, @Body() body: ResolveWrongDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'dispute_id');
    return this.svc.resolveWrong({
      org_id: orgId,
      dispute_id: id,
      analyst_email: body.analyst_email,
      proposed_value: body.proposed_value,
      proposed_coverage_status: body.proposed_coverage_status,
      proposed_confidence: body.proposed_confidence,
      proposed_effective_date: new Date(body.proposed_effective_date),
      source_doc_id: body.source_doc_id,
      ...(body.source_quote ? { source_quote: body.source_quote } : {}),
      ...(body.resolution_notes ? { resolution_notes: body.resolution_notes } : {}),
    });
  }
}
