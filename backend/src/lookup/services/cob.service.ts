/**
 * CobService — Coordination of Benefits primary-payer determination.
 *
 *   Inputs: this claim's "current payer" coverage type + an optional
 *   "other coverage" coverage type.
 *
 *   Output: which payer should be billed first, with the cob_rule citation
 *   that drives the decision. If no rule matches, falls back to "unknown".
 */
import { Injectable, Inject } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import type { PayerType } from '../../database/schema.types';

export interface CobInput {
  current_payer_type: string; // e.g. 'medicare', 'commercial', 'medicaid'
  other_coverage: string; // e.g. 'employer_group_lt_20', 'medicaid'
  dos: Date;
  conditions?: Record<string, unknown>; // employer_size, esrd, treatment_for_motor_vehicle_injury, etc.
}

export type CobStatus =
  | 'current_is_primary'
  | 'current_is_secondary'
  | 'unknown'
  | 'depends_on_facts';

export interface CobResult {
  status: CobStatus;
  rationale: string | null;
  source_url: string | null;
  rule_id?: string;
  primary_coverage_type?: string;
}

const PAYER_TYPE_TO_COVERAGE: Record<PayerType, string | null> = {
  medicare_mac: 'medicare',
  medicare_advantage_org: 'medicare',
  medicaid_state: 'medicaid',
  medicaid_mco: 'medicaid',
  commercial: 'commercial',
  tpa: 'commercial',
  workers_comp: 'workers_comp',
  auto_no_fault: 'auto_no_fault',
  tribal: 'tribal',
  self_insured: 'self_insured',
  other: null,
};

export function payerTypeToCoverageType(t: PayerType): string | null {
  return PAYER_TYPE_TO_COVERAGE[t];
}

@Injectable()
export class CobService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async determine(input: CobInput): Promise<CobResult> {
    if (input.current_payer_type === input.other_coverage) {
      return {
        status: 'unknown',
        rationale: 'Both coverages are the same type — no COB applies',
        source_url: null,
      };
    }

    // Look up rule in either ordering. Cob rules are directional but we encode
    // both possible primaries via 'primary_position' = 'A' | 'B'.
    const rule = await this.db
      .selectFrom('cob_rule')
      .where('effective_date', '<=', input.dos)
      .where((eb) =>
        eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', input.dos)]),
      )
      .where((eb) =>
        eb.or([
          eb.and([
            eb('coverage_type_a', '=', input.current_payer_type),
            eb('coverage_type_b', '=', input.other_coverage),
          ]),
          eb.and([
            eb('coverage_type_a', '=', input.other_coverage),
            eb('coverage_type_b', '=', input.current_payer_type),
          ]),
          eb.and([
            eb('coverage_type_a', '=', 'any_other'),
            eb('coverage_type_b', '=', input.other_coverage),
          ]),
          eb.and([
            eb('coverage_type_a', '=', input.current_payer_type),
            eb('coverage_type_b', '=', 'any_other'),
          ]),
        ]),
      )
      .selectAll()
      .orderBy('effective_date', 'desc')
      .executeTakeFirst();

    if (!rule) {
      return { status: 'unknown', rationale: null, source_url: null };
    }

    const swapped = rule.coverage_type_a !== input.current_payer_type;
    const primaryPosition = rule.primary_position;

    let status: CobStatus;
    let primary_coverage_type = '';
    if (primaryPosition === 'A') {
      const primary = rule.coverage_type_a;
      primary_coverage_type = primary === 'any_other' ? input.current_payer_type : primary;
      status = swapped ? 'current_is_secondary' : 'current_is_primary';
    } else if (primaryPosition === 'B') {
      const primary = rule.coverage_type_b;
      primary_coverage_type = primary === 'any_other' ? input.other_coverage : primary;
      status = swapped ? 'current_is_primary' : 'current_is_secondary';
    } else if (primaryPosition === 'depends') {
      status = 'depends_on_facts';
    } else {
      status = 'unknown';
    }

    return {
      status,
      rationale: rule.rationale,
      source_url: rule.source_url,
      rule_id: rule.id,
      ...(primary_coverage_type ? { primary_coverage_type } : {}),
    };
  }
}
