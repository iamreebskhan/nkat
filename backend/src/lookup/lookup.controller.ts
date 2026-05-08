import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Idempotent } from '../common/idempotency/idempotency.interceptor';
import { RateLimit } from '../common/rate-limit/rate-limit.interceptor';
import { assertUuid } from '../common/uuid';
import { LookupRequestDto } from './dto/lookup-request.dto';
import { LookupResponseDto } from './dto/lookup-response.dto';
import { LookupService } from './services/lookup.service';

@ApiTags('lookup')
@Controller('v1/lookup')
@UseGuards(AuthGuard)
export class LookupController {
  constructor(private readonly lookup: LookupService) {}

  @Post()
  @Idempotent()
  @RateLimit({ scope: 'lookup', limit: 60, refillPerSec: 1 })
  @ApiOperation({
    summary: 'Pre-flight a claim against payer × state × code rules',
    description:
      'Runs deterministic structured checks (coverage, modifiers, NCCI bundling, medical necessity, timely filing, COB, provider taxonomy, 42 CFR Part 2 SUD consent, MHPAEA parity) and returns citation-grounded findings per CARC class.',
  })
  async run(@Req() req: Request, @Body() body: LookupRequestDto): Promise<LookupResponseDto> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return this.lookup.run(body, orgId);
  }
}
