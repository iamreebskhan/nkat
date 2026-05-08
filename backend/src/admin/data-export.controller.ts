/**
 * Self-serve tenant data export — fulfills MSA § 7.1 ("During the Term,
 * Customer may export at any time…").
 *
 *   GET /v1/admin/export/rulebooks    — finalized rulebook history (JSON)
 *   GET /v1/admin/export/audit-log    — audit-log rows for the prior N days (NDJSON)
 *   GET /v1/admin/export/era-835      — denial event aggregates (CSV)
 *
 * All endpoints are RLS-scoped via `runReadOnlyWithTenant`. Exports are
 * streamed in NDJSON or CSV (line-buffered) so a months-long export
 * doesn't blow out memory. Response headers include
 * `Content-Disposition` so the browser saves to a sensible filename.
 *
 * Per the MSA: the customer-facing surface always works during the Term;
 * post-termination, ops cuts a fresh export within 30 days.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';

const MAX_DAYS = 365;
const DEFAULT_DAYS = 90;

@ApiTags('admin')
@Controller('v1/admin/export')
@UseGuards(AuthGuard)
export class DataExportController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get('rulebooks')
  @ApiOperation({ summary: 'Export the caller tenant\'s finalized rulebook history (JSON)' })
  async rulebooks(@Req() req: Request, @Res() res: Response): Promise<void> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const rows = await runReadOnlyWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('client_rulebook')
        .selectAll()
        .where('status', '=', 'finalized')
        .orderBy('finalized_at', 'desc')
        .execute(),
    );
    res.setHeader('content-type', 'application/json');
    res.setHeader(
      'content-disposition',
      `attachment; filename="rulebooks-${orgId}-${ymd()}.json"`,
    );
    res.end(JSON.stringify({ org_id: orgId, exported_at: new Date().toISOString(), rulebooks: rows }, null, 2));
  }

  @Get('audit-log')
  @ApiOperation({ summary: 'Export the caller tenant\'s audit-log rows over N days (NDJSON, streamed)' })
  async auditLog(@Req() req: Request, @Res() res: Response, @Query('days') daysRaw?: string): Promise<void> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const days = clampDays(daysRaw, DEFAULT_DAYS);
    const since = new Date(Date.now() - days * 86_400_000);

    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader(
      'content-disposition',
      `attachment; filename="audit-log-${orgId}-${ymd()}.ndjson"`,
    );

    // Stream in 1k-row pages keyed by (occurred_at desc, id) — keeps
    // memory bounded for tenants with months of activity.
    const PAGE = 1000;
    let lastTime: Date | null = null;
    let lastId: string | null = null;
    while (true) {
      const rows = await runReadOnlyWithTenant(this.db, orgId, (tx) => {
        let q = tx
          .selectFrom('audit_log')
          .selectAll()
          .where('occurred_at', '>=', since)
          .orderBy('occurred_at', 'desc')
          .orderBy('id', 'desc')
          .limit(PAGE);
        if (lastTime && lastId) {
          // Keyset pagination — stable under writes during the dump.
          q = q.where((eb) =>
            eb.or([
              eb('occurred_at', '<', lastTime!),
              eb.and([eb('occurred_at', '=', lastTime!), eb('id', '<', lastId!)]),
            ]),
          );
        }
        return q.execute();
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        res.write(JSON.stringify(r) + '\n');
      }
      const last = rows[rows.length - 1];
      lastTime = last.occurred_at as Date;
      lastId = last.id;
      if (rows.length < PAGE) break;
    }
    res.end();
  }

  @Get('era-835')
  @ApiOperation({ summary: 'Export the caller tenant\'s denial event aggregates (CSV)' })
  async era835(@Req() req: Request, @Res() res: Response, @Query('days') daysRaw?: string): Promise<void> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const days = clampDays(daysRaw, DEFAULT_DAYS);
    const since = new Date(Date.now() - days * 86_400_000);

    res.setHeader('content-type', 'text/csv');
    res.setHeader(
      'content-disposition',
      `attachment; filename="era-835-${orgId}-${ymd()}.csv"`,
    );
    res.write(
      'claim_id,service_dos,billed_amount,paid_amount,adjustment_amount,carc_codes,rarc_codes,group_code\n',
    );

    const rows = await runReadOnlyWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('era_835_record')
        .select([
          'claim_id',
          'service_dos',
          'billed_amount',
          'paid_amount',
          'adjustment_amount',
          'carc_codes',
          'rarc_codes',
          'group_code',
        ])
        .where('ingested_at', '>=', since)
        .orderBy('ingested_at', 'desc')
        .execute(),
    );
    for (const r of rows) {
      res.write(
        [
          csvCell(r.claim_id),
          csvCell(r.service_dos ? new Date(r.service_dos).toISOString().slice(0, 10) : ''),
          csvCell(num(r.billed_amount)),
          csvCell(num(r.paid_amount)),
          csvCell(num(r.adjustment_amount)),
          csvCell((r.carc_codes ?? []).join('|')),
          csvCell((r.rarc_codes ?? []).join('|')),
          csvCell(r.group_code ?? ''),
        ].join(',') + '\n',
      );
    }
    res.end();
  }
}

function clampDays(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new BadRequestException('days must be a positive integer');
  }
  return Math.min(n, MAX_DAYS);
}

function ymd(): string {
  return new Date().toISOString().slice(0, 10);
}

function num(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'number' ? String(v) : String(v);
}

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
