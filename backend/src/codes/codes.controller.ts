/**
 * Code lookup surface (CPT + HCPCS Level II).
 *
 *   GET /v1/codes/:code            — single-code lookup
 *   GET /v1/codes?prefix=…&system=…  — typeahead search
 *
 * Both gated for the AMA-licensed subset (CPT). HCPCS Level II flows
 * through unchanged (CMS public domain).
 */
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { CodeService } from './code.service';

class SearchQuery {
  @IsOptional() @IsString() @MaxLength(8) prefix?: string;
  @IsOptional() @IsIn(['CPT', 'HCPCS2']) system?: 'CPT' | 'HCPCS2';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

@ApiTags('codes')
@Controller('v1/codes')
@UseGuards(AuthGuard)
export class CodesController {
  constructor(private readonly svc: CodeService) {}

  @Get()
  @ApiOperation({ summary: 'Search CPT/HCPCS codes by prefix.' })
  @ApiQuery({ name: 'prefix', required: false })
  @ApiQuery({ name: 'system', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async search(@Req() req: Request, @Query() q: SearchQuery) {
    assertUuid(req.auth?.orgId, 'orgId');
    return {
      ama_licensed: this.svc.hasAmaLicense(),
      items: await this.svc.search(q),
    };
  }

  @Get(':code')
  @ApiOperation({
    summary:
      'Look up a single CPT/HCPCS code. CPT short_descriptors are gated by the ' +
      'AMA license token; HCPCS Level II flows through unchanged.',
  })
  async lookup(@Req() req: Request, @Param('code') code: string) {
    assertUuid(req.auth?.orgId, 'orgId');
    return this.svc.lookup(code);
  }
}
