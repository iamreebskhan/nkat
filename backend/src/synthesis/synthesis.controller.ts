import { Body, Controller, HttpException, HttpStatus, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsObject, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { Idempotent } from '../common/idempotency/idempotency.interceptor';
import { RateLimit } from '../common/rate-limit/rate-limit.interceptor';
import { SynthesisRefusedError } from './synthesis-types';
import { SynthesisService } from './synthesis.service';

class FindingInput {
  @IsString() severity!: 'critical' | 'warning' | 'info' | 'ok';
  @IsString() carc_class!: string;
  @IsString() title!: string;
  @IsString() detail!: string;
  // confidence + citations + recommendation are passed through; class-validator
  // wouldn't add value here vs. trusting the orchestrator's earlier validation.
  @IsObject() metadata?: Record<string, unknown>;
}

class SynthesizeDto {
  @IsString() request_id!: string;
  @IsString() payer_id!: string;
  @IsString() state!: string;
  @IsString() product_line!: string;
  @IsString() date_of_service!: string;
  @IsIn(['biller', 'manager', 'analyst']) audience!: 'biller' | 'manager' | 'analyst';
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => FindingInput)
  findings!: FindingInput[];
}

@ApiTags('synthesis')
@Controller('v1/synthesis')
@UseGuards(AuthGuard)
export class SynthesisController {
  constructor(@Inject(SynthesisService) private readonly svc: SynthesisService) {}

  @Post()
  @Idempotent()
  @RateLimit({ scope: 'synthesis', limit: 30, refillPerSec: 0.5 })
  @ApiOperation({
    summary: 'Synthesize structured lookup findings into a brief plain-English narrative',
    description:
      'Behind feature flag synthesis.enabled. Uses Bedrock when synthesis.provider.name=bedrock and the SDK adapter is wired; otherwise falls back to the deterministic provider. Refusals (flag off, no findings, low confidence) return 422.',
  })
  async synthesize(@Req() req: Request, @Body() body: SynthesizeDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    try {
      // We trust the structured shape; the lookup orchestrator owns truth.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await this.svc.synthesize(orgId, body as any);
    } catch (err) {
      if (err instanceof SynthesisRefusedError) {
        throw new HttpException(
          { error: 'synthesis_refused', reason: err.reason, message: err.message },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw err;
    }
  }
}
