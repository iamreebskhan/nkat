/**
 * DenialService — analytics over the tenant's `era_835_record` data.
 *
 *   - `topByCarc(orgId, days)` — top denial reasons by $ impact + count.
 *   - `preflightCatchRate(orgId, days)` — % of denials our pre-flight warned about.
 *   - `trendByDay(orgId, days)` — denial counts per day for sparkline charts.
 *
 * All queries open a tenant-scoped transaction so RLS enforces isolation.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';

export interface CarcSummary {
  carc: string;
  count: number;
  dollar_impact: number;
  preflight_caught_count: number;
  preflight_caught_dollar: number;
  preflight_catch_rate: number; // 0..1
}

export interface DailyCount {
  day: string; // YYYY-MM-DD
  total: number;
  denied: number;
  preflight_warned: number;
}

export interface CatchRateSummary {
  total_denials: number;
  preflight_warned: number;
  catch_rate: number; // 0..1
  total_dollar_impact: number;
  preflight_caught_dollar: number;
}

@Injectable()
export class DenialService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Aggregate the top N denial reasons (by dollar impact descending, count
   * tiebreaker) over the last `days` days. Includes pre-flight catch rate
   * per CARC.
   */
  async topByCarc(orgId: string, days: number, limit = 10): Promise<CarcSummary[]> {
    const cutoff = daysAgo(days);
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectFrom('era_835_record')
        .where('service_dos', '>=', cutoff)
        .where(sql`array_length(carc_codes, 1)`, '>', 0)
        // unnest CARC array so we get one row per (record, carc).
        .select(({ fn }) => [
          sql<string>`unnest(carc_codes)`.as('carc'),
          fn.count<number>('id').as('count'),
          sql<number>`sum(adjustment_amount::numeric)`.as('dollar_impact'),
          sql<number>`sum(case when preflight_warned then 1 else 0 end)`.as(
            'preflight_caught_count',
          ),
          sql<number>`sum(case when preflight_warned then adjustment_amount::numeric else 0 end)`.as(
            'preflight_caught_dollar',
          ),
        ])
        .groupBy(sql`unnest(carc_codes)`)
        .orderBy('dollar_impact', 'desc')
        .orderBy('count', 'desc')
        .limit(limit)
        .execute();

      return rows.map((r) => ({
        carc: r.carc,
        count: Number(r.count),
        dollar_impact: Number(r.dollar_impact),
        preflight_caught_count: Number(r.preflight_caught_count),
        preflight_caught_dollar: Number(r.preflight_caught_dollar),
        preflight_catch_rate:
          Number(r.count) > 0 ? Number(r.preflight_caught_count) / Number(r.count) : 0,
      }));
    });
  }

  async catchRate(orgId: string, days: number): Promise<CatchRateSummary> {
    const cutoff = daysAgo(days);
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const row = await tx
        .selectFrom('era_835_record')
        .where('service_dos', '>=', cutoff)
        .where(sql`array_length(carc_codes, 1)`, '>', 0)
        .select(({ fn }) => [
          fn.count<number>('id').as('total'),
          sql<number>`sum(case when preflight_warned then 1 else 0 end)`.as('warned'),
          sql<number>`sum(adjustment_amount::numeric)`.as('total_dollar'),
          sql<number>`sum(case when preflight_warned then adjustment_amount::numeric else 0 end)`.as(
            'caught_dollar',
          ),
        ])
        .executeTakeFirst();
      const total = Number(row?.total ?? 0);
      const warned = Number(row?.warned ?? 0);
      return {
        total_denials: total,
        preflight_warned: warned,
        catch_rate: total > 0 ? warned / total : 0,
        total_dollar_impact: Number(row?.total_dollar ?? 0),
        preflight_caught_dollar: Number(row?.caught_dollar ?? 0),
      };
    });
  }

  async trendByDay(orgId: string, days: number): Promise<DailyCount[]> {
    const cutoff = daysAgo(days);
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectFrom('era_835_record')
        .where('service_dos', '>=', cutoff)
        .select(({ fn }) => [
          sql<string>`to_char(service_dos, 'YYYY-MM-DD')`.as('day'),
          fn.count<number>('id').as('total'),
          sql<number>`sum(case when array_length(carc_codes, 1) > 0 then 1 else 0 end)`.as(
            'denied',
          ),
          sql<number>`sum(case when preflight_warned then 1 else 0 end)`.as('warned'),
        ])
        .groupBy(sql`to_char(service_dos, 'YYYY-MM-DD')`)
        .orderBy('day', 'asc')
        .execute();
      return rows.map((r) => ({
        day: r.day,
        total: Number(r.total),
        denied: Number(r.denied),
        preflight_warned: Number(r.warned),
      }));
    });
  }
}

export function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
