/**
 * InstitutionalService — UB-04 / 837I-shaped pre-flight checks.
 *
 *   validateBillType(bill_type, product_line, dos)
 *     — Is the 3-digit bill type valid for this institutional product line?
 *
 *   validateRevenueCodes(revenue_codes, product_line, dos)
 *     — Are all revenue codes on the claim allowed for this product line?
 *       Returns the set of revenue codes that are NOT in the allowlist.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

export interface BillTypeValidationResult {
  bill_type: string;
  known: boolean;
  valid_for_product_line: boolean;
  valid_product_lines: string[];
  description: string | null;
}

export interface RevenueCodeValidationResult {
  /** Revenue codes that ARE valid for the product_line. */
  valid: string[];
  /** Revenue codes that are NOT in the allowlist for this product_line. */
  invalid: string[];
  /** Revenue codes not present in the catalog at all. */
  unknown: string[];
}

@Injectable()
export class InstitutionalService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async validateBillType(
    billType: string,
    productLine: string,
    dos: Date,
  ): Promise<BillTypeValidationResult> {
    const row = await this.db
      .selectFrom('ub04_bill_type')
      .select(['bill_type', 'description', 'valid_for_product_lines'])
      .where('bill_type', '=', billType)
      .where('effective_date', '<=', dos)
      .where((eb) => eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]))
      .executeTakeFirst();
    if (!row) {
      return {
        bill_type: billType,
        known: false,
        valid_for_product_line: false,
        valid_product_lines: [],
        description: null,
      };
    }
    return {
      bill_type: row.bill_type,
      known: true,
      valid_for_product_line: row.valid_for_product_lines.includes(productLine),
      valid_product_lines: row.valid_for_product_lines,
      description: row.description,
    };
  }

  async validateRevenueCodes(
    revenueCodes: string[],
    productLine: string,
    dos: Date,
  ): Promise<RevenueCodeValidationResult> {
    const result: RevenueCodeValidationResult = { valid: [], invalid: [], unknown: [] };
    if (revenueCodes.length === 0) return result;

    // Fetch any catalog rows for these codes (knowing they exist).
    const catalog = await this.db
      .selectFrom('revenue_code')
      .select('code')
      .where('code', 'in', revenueCodes)
      .execute();
    const known = new Set(catalog.map((r) => r.code));

    // Fetch valid (revenue_code, product_line) rows for this product_line.
    const allowed = await this.db
      .selectFrom('revenue_code_product_line')
      .select('revenue_code')
      .where('revenue_code', 'in', revenueCodes)
      .where('product_line', '=', productLine)
      .where('valid', '=', true)
      .where('effective_date', '<=', dos)
      .where((eb) => eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]))
      .execute();
    const validSet = new Set(allowed.map((r) => r.revenue_code));

    for (const code of revenueCodes) {
      if (!known.has(code)) result.unknown.push(code);
      else if (validSet.has(code)) result.valid.push(code);
      else result.invalid.push(code);
    }
    return result;
  }
}
