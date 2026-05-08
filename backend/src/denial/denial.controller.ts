import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DenialService } from './denial.service';

class WindowDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days = 30;
}

@ApiTags('denials')
@Controller('v1/denials')
@UseGuards(AuthGuard)
export class DenialController {
  constructor(private readonly svc: DenialService) {}

  @Get('top')
  @ApiOperation({ summary: 'Top denial reasons (CARC) by dollar impact' })
  @ApiQuery({ name: 'days', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  async top(
    @Req() req: Request,
    @Query() q: WindowDto,
    @Query('limit') limitRaw?: string,
  ) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const limit = limitRaw ? Math.min(50, Math.max(1, Number(limitRaw))) : 10;
    return { window_days: q.days, items: await this.svc.topByCarc(orgId, q.days, limit) };
  }

  @Get('catch-rate')
  @ApiOperation({ summary: 'Pre-flight catch rate over the window' })
  async catchRate(@Req() req: Request, @Query() q: WindowDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return { window_days: q.days, ...(await this.svc.catchRate(orgId, q.days)) };
  }

  @Get('trend')
  @ApiOperation({ summary: 'Daily denial counts for trend chart' })
  async trend(@Req() req: Request, @Query() q: WindowDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return { window_days: q.days, days: await this.svc.trendByDay(orgId, q.days) };
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Consolidated denial summary for the dashboard — KPIs (total denials, $ impact, pre-flight catch rate) + top CARC buckets.',
  })
  async summary(@Req() req: Request, @Query() q: WindowDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const [top, catch_] = await Promise.all([
      this.svc.topByCarc(orgId, q.days, 50),
      this.svc.catchRate(orgId, q.days),
    ]);
    const now = new Date();
    const start = new Date(now.getTime() - q.days * 86_400_000);
    return {
      period_start: start.toISOString(),
      period_end: now.toISOString(),
      total_denials: catch_.total_denials,
      total_dollar_impact: catch_.total_dollar_impact,
      preflight_catch_rate: catch_.catch_rate,
      buckets: top.map((b) => ({
        carc: b.carc,
        rarc: null,                         // RARC not tracked at this aggregation level yet
        count: b.count,
        dollar_impact: b.dollar_impact,
        preflight_caught_count: b.preflight_caught_count,
        description: null,                  // CARC catalog enrichment is a follow-up
      })),
    };
  }
}
