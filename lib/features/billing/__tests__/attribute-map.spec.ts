/**
 * Guards the API-attribute → DB-enum mapping.
 *
 * Regression: the lookup layer queried `pr.attribute = 'prior_auth'`
 * but the payer_rule CHECK constraint only permits
 * 'prior_auth_required' (and 5 other long-form names). 6 of 9
 * attributes were silently un-answerable. ATTRIBUTE_DB_MAP fixes it;
 * every mapped target must be a value the DB CHECK allows.
 */
import { describe, expect, it } from "vitest";

import {
  ATTRIBUTE_DB_MAP,
  type PayerRuleAttribute,
} from "../payer-rule.repository";

// The exact CHECK constraint set from
// db/migrations/0003_payers_and_rules.sql.
const DB_ALLOWED_ATTRIBUTES = new Set([
  "covered",
  "telehealth_allowed",
  "pos_allowed",
  "modifier_required",
  "modifier_optional",
  "modifier_combinations",
  "frequency_limit",
  "prior_auth_required",
  "medical_necessity_icd10",
  "bundled_with",
  "documentation_required",
  "provider_taxonomy_allowed",
  "timely_filing_days",
  "mhpaea_paired_code",
  "place_of_service_payment",
  "revenue_code_allowed",
  "surprise_billing_protected",
  "abn_recommended",
  "units_per_period_max",
  "copay_or_costshare",
]);

const ALL_API_ATTRIBUTES: PayerRuleAttribute[] = [
  "covered",
  "prior_auth",
  "telehealth",
  "provider_type",
  "billing_limit",
  "addon_compatible",
  "documentation",
  "frequency_limit",
  "modifier_required",
];

describe("ATTRIBUTE_DB_MAP", () => {
  it("maps every API attribute to a DB-CHECK-valid value", () => {
    for (const apiAttr of ALL_API_ATTRIBUTES) {
      const dbAttr = ATTRIBUTE_DB_MAP[apiAttr];
      expect(dbAttr, `missing map for ${apiAttr}`).toBeDefined();
      expect(
        DB_ALLOWED_ATTRIBUTES.has(dbAttr),
        `${apiAttr} → ${dbAttr} is not a DB-allowed attribute`,
      ).toBe(true);
    }
  });

  it("covers all 9 API attributes (no gaps)", () => {
    expect(Object.keys(ATTRIBUTE_DB_MAP).sort()).toEqual(
      [...ALL_API_ATTRIBUTES].sort(),
    );
  });

  it("keeps identity for the three already-aligned names", () => {
    expect(ATTRIBUTE_DB_MAP.covered).toBe("covered");
    expect(ATTRIBUTE_DB_MAP.frequency_limit).toBe("frequency_limit");
    expect(ATTRIBUTE_DB_MAP.modifier_required).toBe("modifier_required");
  });
});
