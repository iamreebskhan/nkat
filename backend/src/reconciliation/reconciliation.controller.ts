import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { ReconciliationService } from './reconciliation.service';

class CreateRulebookDto {
  @IsString() client_id!: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class DecideDto {
  @IsString() client_rule_id!: string;
  @IsIn(['accept_authoritative', 'keep_client', 'edit_custom', 'intentional_deviation'])
  decision!: 'accept_authoritative' | 'keep_client' | 'edit_custom' | 'intentional_deviation';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsString() decided_by!: string;
}

class FinalizeDto {
  @IsString() finalized_by!: string;
}

@ApiTags('reconciliation')
@Controller('v1/reconciliation')
@UseGuards(AuthGuard)
export class ReconciliationController {
  constructor(private readonly svc: ReconciliationService) {}

  @Post('rulebooks')
  @ApiOperation({ summary: 'Open a new draft client_rulebook' })
  async createRulebook(@Req() req: Request, @Body() body: CreateRulebookDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(body.client_id, 'client_id');
    return this.svc.createRulebook(orgId, body.client_id, body.notes);
  }

  @Get('rulebooks/:id/diff')
  @ApiOperation({ summary: 'Compute diff between authoritative + this rulebook' })
  async diff(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'rulebook_id');
    return this.svc.computeDiff(orgId, id);
  }

  @Post('decisions')
  @ApiOperation({ summary: 'Record a per-row reconciliation decision' })
  async decide(@Req() req: Request, @Body() body: DecideDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(body.client_rule_id, 'client_rule_id');
    await this.svc.decide(
      orgId,
      body.client_rule_id,
      body.decision,
      body.note ?? null,
      body.decided_by,
    );
    return { ok: true };
  }

  @Post('rulebooks/:id/finalize')
  @ApiOperation({ summary: 'Finalize a draft rulebook; computes integrity_hash' })
  async finalize(@Req() req: Request, @Param('id') id: string, @Body() body: FinalizeDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'rulebook_id');
    return this.svc.finalize(orgId, id, body.finalized_by);
  }
}
