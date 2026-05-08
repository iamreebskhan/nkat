import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { HccRiskAdjustmentService } from './hcc.service';

const ICD10_REGEX = /^[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/;

class ScoreDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Matches(ICD10_REGEX, { each: true, message: 'each diagnosis must be an ICD-10 code' })
  icd10!: string[];

  @IsOptional() @IsInt() @Min(2020) @Max(2099)
  effective_year?: number;
}

@ApiTags('risk-adjustment')
@Controller('v1/risk-adjustment')
@UseGuards(AuthGuard)
export class RiskAdjustmentController {
  constructor(@Inject(HccRiskAdjustmentService) private readonly svc: HccRiskAdjustmentService) {}

  @Get('hcc-mapping/:icd10')
  @ApiOperation({
    summary: 'Look up CMS-HCC v28 + RxHCC mappings for a single ICD-10',
  })
  @ApiQuery({ name: 'version', required: false, description: 'HCC version (default V28)' })
  @ApiQuery({ name: 'year', required: false, description: 'Effective year (default current)' })
  async hccMapping(
    @Req() req: Request,
    @Param('icd10') icd10: string,
    @Query('version') version?: string,
    @Query('year') year?: string,
  ) {
    assertUuid(req.auth?.orgId, 'orgId');
    if (!ICD10_REGEX.test(icd10)) {
      return { icd10, mappings: [], error: 'INVALID_ICD10' };
    }
    const items = await this.svc.getMappings({
      icd10,
      hcc_version: version,
      effective_year: year ? parseInt(year, 10) : undefined,
    });
    return { icd10, mappings: items };
  }

  @Post('raf')
  @ApiOperation({
    summary: 'Compute CMS-HCC v28 Risk Adjustment Factor (RAF) for a list of ICD-10s',
    description:
      'Maps each ICD-10 to its V28 HCC, applies the hierarchy (more-severe HCC trumps less-severe), sums surviving raf_weights, and returns total + breakdown + unmapped ICDs. ' +
      'For Medicare Advantage capitation revenue analytics. RLS enforces tenant isolation on any tenant-scoped persistence layered on top.',
  })
  async raf(@Req() req: Request, @Body() body: ScoreDto) {
    assertUuid(req.auth?.orgId, 'orgId');
    return body.effective_year !== undefined
      ? this.svc.scorePatient(body.icd10, body.effective_year)
      : this.svc.scorePatient(body.icd10);
  }
}
