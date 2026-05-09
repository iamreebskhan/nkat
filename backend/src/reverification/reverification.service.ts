/**
 * ReverificationService — 90-day re-verification scheduling for analyst-
 * attested payer_rule rows.
 *
 *   schedule()    — inserts a `pending` reverification row for a payer_rule
 *                   90 days out (or `daysOut` override).
 *   listDue()     — returns reverifications whose reverify_by <= today and
 *                   are still 'pending'.
 *   markOverdue() — flips pending past their reverify_by to 'overdue'.
 *   markCompleted() — analyst completes a reverification; appends another
 *                   90 days for the next cycle.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

export const DEFAULT_REVERIFY_DAYS = 90;

function addDays(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

@Injectable()
export class ReverificationService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async schedule(
    payerRuleId: string,
    daysOut: number = DEFAULT_REVERIFY_DAYS,
    now: Date = new Date(),
  ): Promise<string> {
    const due = addDays(now, daysOut);
    const inserted = await this.db
      .insertInto('attestation_reverification')
      .values({
        payer_rule_id: payerRuleId,
        reverify_by: due,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  async listDue(
    asOf: Date = new Date(),
    limit = 100,
  ): Promise<{ id: string; payer_rule_id: string; reverify_by: Date; days_overdue: number }[]> {
    const rows = await this.db
      .selectFrom('attestation_reverification')
      .select(['id', 'payer_rule_id', 'reverify_by'])
      .where('status', '=', 'pending')
      .where('reverify_by', '<=', asOf)
      .orderBy('reverify_by', 'asc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      payer_rule_id: r.payer_rule_id,
      reverify_by: r.reverify_by,
      days_overdue: Math.max(
        0,
        Math.floor((asOf.getTime() - r.reverify_by.getTime()) / 86_400_000),
      ),
    }));
  }

  async markOverdue(asOf: Date = new Date()): Promise<{ marked: number }> {
    const result = await this.db
      .updateTable('attestation_reverification')
      .set({ status: 'overdue' })
      .where('status', '=', 'pending')
      .where('reverify_by', '<', asOf)
      .executeTakeFirst();
    return { marked: Number(result.numUpdatedRows ?? 0) };
  }

  async markCompleted(
    reverificationId: string,
    completedBy: string,
    now: Date = new Date(),
  ): Promise<{ next_reverify_by: Date }> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('attestation_reverification')
        .select(['payer_rule_id'])
        .where('id', '=', reverificationId)
        .executeTakeFirst();
      if (!row) throw new Error(`Reverification ${reverificationId} not found`);

      await tx
        .updateTable('attestation_reverification')
        .set({ status: 'completed', completed_at: now, completed_by: completedBy })
        .where('id', '=', reverificationId)
        .execute();

      const next = addDays(now, DEFAULT_REVERIFY_DAYS);
      await tx
        .insertInto('attestation_reverification')
        .values({
          payer_rule_id: row.payer_rule_id,
          reverify_by: next,
        })
        .execute();

      return { next_reverify_by: next };
    });
  }
}

export const _testing = { addDays };
