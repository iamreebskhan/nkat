/**
 * TimelyFilingService — given DOS, payer, state, product_line and the date the
 * claim is being filed (defaults to today), determine whether we're past the
 * payer's filing window. Sources the window from `payer_rule` rows with
 * attribute = 'timely_filing_days'.
 */
import { Injectable, Inject } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';

export interface TimelyFilingInput {
  payer_id: string;
  state: string;
  product_line: string;
  dos: Date;
  filing_date: Date;
}

export interface TimelyFilingResult {
  status: 'within_window' | 'past_window' | 'unknown';
  window_days: number | null;
  days_elapsed: number;
  days_remaining: number | null;
  source_doc_id?: string;
  source_quote?: string;
  source_url?: string;
}

export function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / 86_400_000);
}

@Injectable()
export class TimelyFilingService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async check(input: TimelyFilingInput): Promise<TimelyFilingResult> {
    const days_elapsed = daysBetween(input.dos, input.filing_date);

    const rule = await this.db
      .selectFrom('payer_rule as pr')
      .leftJoin('source_document as sd', 'sd.id', 'pr.source_doc_id')
      .where('pr.payer_id', '=', input.payer_id)
      .where('pr.state', '=', input.state)
      .where('pr.product_line', '=', input.product_line)
      .where('pr.attribute', '=', 'timely_filing_days')
      .where('pr.effective_date', '<=', input.dos)
      .where((eb) =>
        eb.or([eb('pr.expiration_date', 'is', null), eb('pr.expiration_date', '>', input.dos)]),
      )
      .orderBy('pr.effective_date', 'desc')
      .select([
        'pr.timely_filing_days',
        'pr.source_doc_id',
        'pr.source_quote',
        'sd.url as source_url',
      ])
      .executeTakeFirst();

    if (!rule || rule.timely_filing_days === null || rule.timely_filing_days === undefined) {
      return {
        status: 'unknown',
        window_days: null,
        days_elapsed,
        days_remaining: null,
      };
    }

    const window_days = rule.timely_filing_days;
    const days_remaining = window_days - days_elapsed;
    return {
      status: days_remaining >= 0 ? 'within_window' : 'past_window',
      window_days,
      days_elapsed,
      days_remaining,
      ...(rule.source_doc_id ? { source_doc_id: rule.source_doc_id } : {}),
      ...(rule.source_quote ? { source_quote: rule.source_quote } : {}),
      ...(rule.source_url ? { source_url: rule.source_url } : {}),
    };
  }
}
