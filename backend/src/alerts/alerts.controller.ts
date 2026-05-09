/**
 * Tenant alert inbox.
 *
 *   GET   /v1/alerts                — list (filter by severity / unread)
 *   PATCH /v1/alerts/:id/read       — mark acknowledged
 *
 * Maps the underlying `alert` row shape to a UI-friendly view:
 *   - `alert_type` → `type`
 *   - `acknowledged_at` → `read_at`
 *   - title + detail are derived from `payload` when present, with a
 *     fall-through default per `alert_type`.
 *
 * Severity maps `critical|high|medium|info` (from drift-detector) to
 * the UI's three-bucket model `critical|warning|info`.
 */
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsBooleanString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import type { Generated } from 'kysely';
import type { AlertRow } from '../database/schema.types';

/**
 * Hydrated form of AlertRow — once a row is read from the DB, every
 * `Generated<T>` column is a concrete `T`. The mapper unwraps them
 * so the view function can operate on plain primitives.
 */
type AlertReadRow = {
  [K in keyof AlertRow]: AlertRow[K] extends Generated<infer U> ? U : AlertRow[K];
};

type UiSeverity = 'critical' | 'warning' | 'info';

interface AlertView {
  id: string;
  type: string;
  severity: UiSeverity;
  title: string;
  detail: string | null;
  payer_id: string | null;
  effective_at: string | null;
  read_at: string | null;
  created_at: string;
}

class ListAlertsQuery {
  @IsOptional()
  @IsIn(['critical', 'warning', 'info'])
  severity?: UiSeverity;

  @IsOptional()
  @IsBooleanString()
  unread?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class AckBodyDto {
  @IsOptional()
  @IsString()
  note?: string;
}

@ApiTags('alerts')
@Controller('v1/alerts')
@UseGuards(AuthGuard)
export class AlertsController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'List alerts for the calling tenant' })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'unread', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(@Req() req: Request, @Query() q: ListAlertsQuery): Promise<{ items: AlertView[] }> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const limit = Math.min(500, q.limit ?? 100);
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      let query = tx
        .selectFrom('alert')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('created_at', 'desc')
        .limit(limit);
      if (q.unread === 'true') query = query.where('acknowledged_at', 'is', null);
      // Severity filter — UI's three-bucket model maps to:
      //   critical → 'critical'
      //   warning  → 'high' OR 'medium'
      //   info     → 'info'
      if (q.severity === 'critical') query = query.where('severity', '=', 'critical');
      else if (q.severity === 'warning') query = query.where('severity', 'in', ['high', 'medium']);
      else if (q.severity === 'info') query = query.where('severity', '=', 'info');

      const rows = await query.execute();
      return { items: rows.map(toView) };
    });
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark an alert as read (acknowledged)' })
  async markRead(@Req() req: Request, @Param('id') id: string, @Body() _body: AckBodyDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    assertUuid(id, 'id');
    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .updateTable('alert')
        .set({
          acknowledged_at: sql`now()`,
          acknowledged_by: userId,
        })
        .where('id', '=', id)
        .where('org_id', '=', orgId)
        .where('acknowledged_at', 'is', null)
        .returning(['id', 'acknowledged_at'])
        .executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'ALERT_NOT_FOUND_OR_ALREADY_READ' });
      return r;
    });
  }
}

/**
 * Map AlertRow to the UI view. Title + detail come from `payload`
 * when the drift detector or producer wrote them; otherwise a static
 * default per type fills in.
 */
export function toView(r: AlertReadRow): AlertView {
  const p = r.payload as Record<string, unknown>;
  const title = pickString(p, 'title') ?? defaultTitle(r.alert_type);
  const detail = pickString(p, 'detail') ?? pickString(p, 'message') ?? null;
  const payerId = pickString(p, 'payer_id');
  const effective = pickString(p, 'effective_at');
  return {
    id: r.id,
    type: r.alert_type,
    severity: mapSeverity(r.severity),
    title,
    detail,
    payer_id: payerId ?? null,
    effective_at: effective ?? null,
    read_at: r.acknowledged_at ? r.acknowledged_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
  };
}

function pickString(p: Record<string, unknown>, k: string): string | undefined {
  const v = p?.[k];
  return typeof v === 'string' ? v : undefined;
}

function mapSeverity(s: AlertReadRow['severity']): UiSeverity {
  if (s === 'critical') return 'critical';
  if (s === 'high' || s === 'medium') return 'warning';
  return 'info';
}

function defaultTitle(t: AlertReadRow['alert_type']): string {
  switch (t) {
    case 'rule_change':
      return 'A payer rule has changed';
    case 'new_diff':
      return 'New rule diff detected';
    case 'source_expired':
      return 'Authoritative source has expired';
    case 'consent_required':
      return 'Patient consent required (42 CFR Part 2)';
    case 'attestation_expiring':
      return 'Analyst attestation expiring soon';
    case 'extraction_drift':
      return 'Extractor accuracy drift detected';
    case 'source_unavailable':
      return 'Authoritative source is unreachable';
    default:
      return 'Alert';
  }
}
