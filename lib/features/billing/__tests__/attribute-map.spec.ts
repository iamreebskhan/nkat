/**
 * Guards the API-attribute → DB-enum mapping.
 *
 * Regression: the lookup layer queried `pr.attribute = 'prior_auth'`
 * but the payer_rule CHECK constraint only permits
 * 'prior_auth_required' (and 5 other long-form names). 6 of 9
 * attributes were silently un-answerable. ATTRIBUTE_DB_MAP fixes it;
 * every mapped target must be a value the DB CHECK allows.
 *
 * Second regression (2026-08): the map itself was the gap. It had nine
 * entries and no `pos_allowed`, so 123 live pos_allowed rules could not
 * be reached by any query — place of service decides whether a home
 * visit billed POS 12 is paid. Now ten.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RULEBOOK_ATTRIBUTES } from "@/lib/features/rulebook/rulebook.types";

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
  "pos_allowed",
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

  it("covers all 10 API attributes (no gaps)", () => {
    expect(ALL_API_ATTRIBUTES).toHaveLength(10);
    expect(Object.keys(ATTRIBUTE_DB_MAP).sort()).toEqual(
      [...ALL_API_ATTRIBUTES].sort(),
    );
  });

  it("keeps identity for the four already-aligned names", () => {
    expect(ATTRIBUTE_DB_MAP.covered).toBe("covered");
    expect(ATTRIBUTE_DB_MAP.frequency_limit).toBe("frequency_limit");
    expect(ATTRIBUTE_DB_MAP.modifier_required).toBe("modifier_required");
    expect(ATTRIBUTE_DB_MAP.pos_allowed).toBe("pos_allowed");
  });

  // The rulebook grid and the lookup share one attribute vocabulary. When
  // they drifted, 123 live pos_allowed rules were unreachable from either.
  it("stays in step with RULEBOOK_ATTRIBUTES", () => {
    expect([...RULEBOOK_ATTRIBUTES].sort()).toEqual(
      [...ALL_API_ATTRIBUTES].sort(),
    );
  });

  // The gap this file was supposed to close and did not.
  //
  // Every assertion above compares two lists we maintain by hand, so they
  // agreed with each other while the HTTP surface disagreed with both:
  // pos_allowed was mapped, typed and rulebook-listed, and the zod enum in
  // app/api/billing/lookup/route.ts still rejected it. 123 rules stayed
  // unreachable and this suite passed.
  //
  // So read the route file itself. Parsing source in a test is ugly; a
  // test that cannot see the surface it guards is worse.
  it("the lookup API accepts every attribute the mapper supports", () => {
    const route = readFileSync(
      join(process.cwd(), "app/api/billing/lookup/route.ts"),
      "utf8",
    );
    const block = route.match(/attribute:[\s\S]*?z\s*\.enum\(\[([\s\S]*?)\]\)/);
    expect(block, "could not find the attribute z.enum in the lookup route").toBeTruthy();
    const exposed = [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(exposed.sort()).toEqual([...ALL_API_ATTRIBUTES].sort());
  });
});
