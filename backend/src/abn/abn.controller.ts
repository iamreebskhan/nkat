/**
 * ABN admin surface.
 *
 *   POST /v1/abn                      — create record
 *   GET  /v1/abn                      — list (filterable by client_id)
 *   POST /v1/abn/:id/pdf              — render PDF (body: notifier + patient + reason context)
 */
import {
  Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { AbnService } from './abn.service';

class CreateAbnDto {
  @IsString() client_id!: string;
  @IsString() @MaxLength(200) patient_external_id!: string;
  @IsString() @MaxLength(64) form_version!: string;
  @IsDateString() signed_at!: string;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) service_codes!: string[];
  @IsOptional() @IsString() @MaxLength(200) reason_code?: string;
  @IsOptional() @IsString() @MaxLength(64) estimated_cost?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class ListQueryDto {
  @IsOptional() @IsString() client_id?: string;
  @IsOptional() @IsInt() @Min(1) limit?: number;
}

class RenderPdfDto {
  @IsString() @MaxLength(200) notifier_name!: string;
  @IsString() @MaxLength(500) notifier_address!: string;
  @IsString() @MaxLength(200) patient_name!: string;
  @IsString() @MaxLength(2000) service_description!: string;
  @IsString() @MaxLength(2000) reason_for_noncoverage!: string;
  @IsOptional() @IsIn(['OPTION_1', 'OPTION_2', 'OPTION_3']) option_selected?: 'OPTION_1' | 'OPTION_2' | 'OPTION_3';
}

@ApiTags('abn')
@Controller('v1/abn')
@UseGuards(AuthGuard)
export class AbnController {
  constructor(private readonly svc: AbnService) {}

  @Post()
  @ApiOperation({ summary: 'Create an ABN record (CMS-R-131)' })
  async create(@Req() req: Request, @Body() body: CreateAbnDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(body.client_id, 'client_id');
    return this.svc.create({
      orgId,
      clientId: body.client_id,
      patientExternalId: body.patient_external_id,
      formVersion: body.form_version,
      signedAt: new Date(body.signed_at),
      serviceCodes: body.service_codes,
      reasonCode: body.reason_code ?? null,
      estimatedCost: body.estimated_cost ?? null,
      notes: body.notes ?? null,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List ABN records for the calling tenant' })
  async list(@Req() req: Request, @Query() q: ListQueryDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const items = await this.svc.list(orgId, {
      client_id: q.client_id,
      limit: q.limit,
    });
    return { items };
  }

  @Post(':id/pdf')
  @HttpCode(200)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Render the CMS-R-131 form for an ABN record as a PDF' })
  async pdf(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() body: RenderPdfDto,
  ) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'id');
    const buf = await this.svc.getPdf(orgId, id, {
      notifierName: body.notifier_name,
      notifierAddress: body.notifier_address,
      patientName: body.patient_name,
      serviceDescription: body.service_description,
      reasonForNoncoverage: body.reason_for_noncoverage,
      optionSelected: body.option_selected ?? null,
    });
    res.setHeader('Content-Disposition', `attachment; filename="abn-${id}.pdf"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }
}
