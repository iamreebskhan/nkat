/**
 * ProviderTaxonomyService — checks whether the rendering provider's NUCC
 * taxonomy is in the `payer_rule.provider_taxonomy_allowed` list for the
 * given (payer, state, product_line, code).
 *
 * Empty allowed list (or no rule) means "no restriction known".
 */
import { Injectable, Inject } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';

export interface ProviderTaxonomyInput {
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  provider_taxonomy: string;
  dos: Date;
}

export type ProviderTaxonomyStatus = 'allowed' | 'not_allowed' | 'unknown';

export interface ProviderTaxonomyResult {
  status: ProviderTaxonomyStatus;
  allowed_taxonomies: string[];
  rule_id: string | null;
  source_url: string | null;
}

@Injectable()
export class ProviderTaxonomyService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async check(input: ProviderTaxonomyInput): Promise<ProviderTaxonomyResult> {
    const row = await this.db
      .selectFrom('payer_rule as pr')
      .leftJoin('source_document as sd', 'sd.id', 'pr.source_doc_id')
      .where('pr.payer_id', '=', input.payer_id)
      .where('pr.state', '=', input.state)
      .where('pr.product_line', '=', input.product_line)
      .where('pr.code', '=', input.code)
      .where('pr.attribute', '=', 'provider_taxonomy_allowed')
      .where('pr.effective_date', '<=', input.dos)
      .where((eb) =>
        eb.or([eb('pr.expiration_date', 'is', null), eb('pr.expiration_date', '>', input.dos)]),
      )
      .orderBy('pr.effective_date', 'desc')
      .select(['pr.id as rule_id', 'pr.provider_taxonomy_allowed', 'sd.url as source_url'])
      .executeTakeFirst();

    if (!row || row.provider_taxonomy_allowed.length === 0) {
      return {
        status: 'unknown',
        allowed_taxonomies: row?.provider_taxonomy_allowed ?? [],
        rule_id: row?.rule_id ?? null,
        source_url: row?.source_url ?? null,
      };
    }

    const status: ProviderTaxonomyStatus = row.provider_taxonomy_allowed.includes(input.provider_taxonomy)
      ? 'allowed'
      : 'not_allowed';

    return {
      status,
      allowed_taxonomies: row.provider_taxonomy_allowed,
      rule_id: row.rule_id,
      source_url: row.source_url ?? null,
    };
  }
}
