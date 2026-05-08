/**
 * MedicalNecessityService — for a given (payer, state, product_line, code,
 * DOS), is at least one of the supplied diagnosis codes on the LCD/NCD-derived
 * medical-necessity ICD-10 list?
 *
 * `payer_rule.attribute = 'medical_necessity_icd10'` rows store a value of
 * shape: `{ "codes": ["Z51.5", "C18.0", ...] }` — see the ingestor for shape.
 *
 * The check is permissive: if no rule exists (coverage_status='unknown'), we
 * return 'unknown' and let the caller decide whether to refuse or proceed.
 */
import { Injectable, Inject } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';

export interface MedicalNecessityInput {
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  diagnoses: string[];
  dos: Date;
}

export type MedicalNecessityStatus = 'covered' | 'not_covered' | 'unknown';

export interface MedicalNecessityResult {
  status: MedicalNecessityStatus;
  matched_diagnoses: string[];
  required_one_of: string[] | null; // null when no rule is on file
  rule_id: string | null;
  source_url: string | null;
  source_quote: string | null;
  effective_date: Date | null;
}

@Injectable()
export class MedicalNecessityService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async check(input: MedicalNecessityInput): Promise<MedicalNecessityResult> {
    const row = await this.db
      .selectFrom('payer_rule as pr')
      .leftJoin('source_document as sd', 'sd.id', 'pr.source_doc_id')
      .where('pr.payer_id', '=', input.payer_id)
      .where('pr.state', '=', input.state)
      .where('pr.product_line', '=', input.product_line)
      .where('pr.code', '=', input.code)
      .where('pr.attribute', '=', 'medical_necessity_icd10')
      .where('pr.effective_date', '<=', input.dos)
      .where((eb) =>
        eb.or([eb('pr.expiration_date', 'is', null), eb('pr.expiration_date', '>', input.dos)]),
      )
      .orderBy('pr.effective_date', 'desc')
      .select([
        'pr.id as rule_id',
        'pr.value',
        'pr.source_quote',
        'pr.effective_date',
        'sd.url as source_url',
      ])
      .executeTakeFirst();

    if (!row) {
      return {
        status: 'unknown',
        matched_diagnoses: [],
        required_one_of: null,
        rule_id: null,
        source_url: null,
        source_quote: null,
        effective_date: null,
      };
    }

    const required = (row.value as { codes?: string[] }).codes ?? [];
    const requiredSet = new Set(required.map((c) => c.toUpperCase()));
    const matched = input.diagnoses.filter((d) => requiredSet.has(d.toUpperCase()));

    return {
      status: matched.length > 0 ? 'covered' : 'not_covered',
      matched_diagnoses: matched,
      required_one_of: required,
      rule_id: row.rule_id,
      source_url: row.source_url ?? null,
      source_quote: row.source_quote ?? null,
      effective_date: row.effective_date,
    };
  }
}
