/**
 * MhpaeaParityService — DB-backed wrapper around the parity engine.
 * Loads all attribute rules for the BH code and its paired med/surg code,
 * then runs the pure evaluator.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import { evaluateParity, type ParityFlag, type ParityRuleInput } from './mhpaea-parity.engine';
import type { MhpaeaClassification } from '../../database/schema.types';

export interface MhpaeaCheckInput {
  payer_id: string;
  state: string;
  product_line: string;
  bh_code: string;
  dos: Date;
  classification?: MhpaeaClassification;
}

export interface MhpaeaCheckResult {
  bh_code: string;
  pairs_checked: { med_surg_code: string; classification: MhpaeaClassification }[];
  flags: ParityFlag[];
}

@Injectable()
export class MhpaeaParityService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async check(input: MhpaeaCheckInput): Promise<MhpaeaCheckResult> {
    // 1. Find paired med/surg codes for this BH code.
    let pairsQuery = this.db
      .selectFrom('mhpaea_parity_pair')
      .select(['med_surg_code', 'classification'])
      .where('behavioral_health_code', '=', input.bh_code)
      .where('effective_date', '<=', input.dos)
      .where((eb) =>
        eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', input.dos)]),
      );
    if (input.classification) {
      pairsQuery = pairsQuery.where('classification', '=', input.classification);
    }
    const pairs = await pairsQuery.execute();
    if (pairs.length === 0) {
      return { bh_code: input.bh_code, pairs_checked: [], flags: [] };
    }

    const flags: ParityFlag[] = [];
    for (const pair of pairs) {
      const [bhRules, msRules] = await Promise.all([
        this.loadRules(input.payer_id, input.state, input.product_line, input.bh_code, input.dos),
        this.loadRules(
          input.payer_id,
          input.state,
          input.product_line,
          pair.med_surg_code,
          input.dos,
        ),
      ]);
      flags.push(...evaluateParity(input.bh_code, pair.med_surg_code, bhRules, msRules));
    }
    return {
      bh_code: input.bh_code,
      pairs_checked: pairs.map((p) => ({
        med_surg_code: p.med_surg_code,
        classification: p.classification,
      })),
      flags,
    };
  }

  private async loadRules(
    payer_id: string,
    state: string,
    product_line: string,
    code: string,
    dos: Date,
  ): Promise<ParityRuleInput[]> {
    const rows = await this.db
      .selectFrom('payer_rule')
      .select(['attribute', 'value', 'coverage_status'])
      .where('payer_id', '=', payer_id)
      .where('state', '=', state)
      .where('product_line', '=', product_line)
      .where('code', '=', code)
      .where('effective_date', '<=', dos)
      .where((eb) => eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]))
      .execute();
    return rows.map((r) => ({
      code,
      attribute: r.attribute,
      value: r.value,
      coverage_status: r.coverage_status,
    }));
  }
}
