/**
 * PayerRuleRepository — DOS-aware lookup of payer_rule rows. All reads are
 * against global (non-RLS) tables so they don't need a tenant context.
 */
import { Injectable, Inject } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import type { PayerRuleAttribute, PayerType } from '../../database/schema.types';

export interface FetchRuleInput {
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  dos: Date;
}

export interface PayerRuleHit {
  rule_id: string;
  attribute: PayerRuleAttribute;
  value: Record<string, unknown>;
  coverage_status: 'covered' | 'not_covered' | 'varies' | 'unknown';
  confidence: number;
  effective_date: Date;
  expiration_date: Date | null;
  source_doc_id: string;
  source_url: string | null;
  source_quote: string | null;
  source_page: number | null;
}

@Injectable()
export class PayerRuleRepository {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async fetchOne(input: FetchRuleInput): Promise<PayerRuleHit | null> {
    const row = await this.db
      .selectFrom('payer_rule as pr')
      .leftJoin('source_document as sd', 'sd.id', 'pr.source_doc_id')
      .where('pr.payer_id', '=', input.payer_id)
      .where('pr.state', '=', input.state)
      .where('pr.product_line', '=', input.product_line)
      .where('pr.code', '=', input.code)
      .where('pr.attribute', '=', input.attribute)
      .where('pr.effective_date', '<=', input.dos)
      .where((eb) =>
        eb.or([eb('pr.expiration_date', 'is', null), eb('pr.expiration_date', '>', input.dos)]),
      )
      .orderBy('pr.effective_date', 'desc')
      .select([
        'pr.id as rule_id',
        'pr.attribute',
        'pr.value',
        'pr.coverage_status',
        'pr.confidence',
        'pr.effective_date',
        'pr.expiration_date',
        'pr.source_doc_id',
        'pr.source_quote',
        'pr.source_page',
        'sd.url as source_url',
      ])
      .executeTakeFirst();

    if (!row) return null;
    return {
      rule_id: row.rule_id,
      attribute: row.attribute,
      value: row.value,
      coverage_status: row.coverage_status,
      confidence: parseFloat(row.confidence),
      effective_date: row.effective_date,
      expiration_date: row.expiration_date,
      source_doc_id: row.source_doc_id,
      source_url: row.source_url ?? null,
      source_quote: row.source_quote,
      source_page: row.source_page,
    };
  }

  async getPayerType(payer_id: string): Promise<PayerType | null> {
    const row = await this.db
      .selectFrom('payer')
      .select('payer_type')
      .where('id', '=', payer_id)
      .executeTakeFirst();
    return row?.payer_type ?? null;
  }
}
