/**
 * The practice's own fee schedule in pricing (0118; doc:74; Mark Q4 default):
 * billed = the practice's fee, expected = the payer's rate. Without a fee
 * schedule, billed and expected are the same, as every bill was before. Pure.
 */
import { describe, expect, it } from "vitest";

import { buildSuperbill, describePriceSource, priceCodes, type PayerRate } from "../superbill-pure";

const rate = (code: string, cents: number): PayerRate => ({
  code, rateCents: cents, npPaRateCents: null, facilityRateCents: null, payerRuleId: `r-${code}`, rateBasis: null,
  effectiveDate: "2026-01-01",
});

describe("priceCodes with the practice's fees", () => {
  it("CONTROL: with no fee schedule, billed is the payer's rate and so is expected", () => {
    const p = priceCodes(["99349", "G0318"], "MD", [rate("99349", 7013)], { units: { G0318: 2 } });
    expect(p.totalCents).toBe(7013 + 2938 * 2);
    expect(p.expectedCents).toBe(p.totalCents);
    expect(p.lines.every((l) => l.feeCents === undefined)).toBe(true);
  });

  it("bills the fee per unit where the practice has one, and expects the payer's rate", () => {
    const p = priceCodes(["99349", "G0318"], "MD", [rate("99349", 7013)], {
      units: { G0318: 2 },
      fees: [{ code: "99349", feeCents: 15000 }, { code: "G0318", feeCents: 4000 }],
    });
    const em = p.lines.find((l) => l.code === "99349")!;
    const g = p.lines.find((l) => l.code === "G0318")!;
    expect(em).toMatchObject({ feeCents: 15000, rateCents: 7013, chargeCents: 15000, source: "payer_fee_schedule" });
    // G0318 has no payer rate here: the reference table is what is expected.
    expect(g).toMatchObject({ feeCents: 4000, rateCents: 2938, units: 2, chargeCents: 8000, source: "reference_table" });
    expect(p.totalCents).toBe(15000 + 8000);
    expect(p.expectedCents).toBe(7013 + 2938 * 2);
  });

  it("bills a fee with no rate at all, and says the expected payment is unknown", () => {
    const p = priceCodes(["99490"], "NP_PA", [], { fees: [{ code: "99490", feeCents: 6500 }] });
    expect(p.totalCents).toBe(6500);
    // Unknown, never $0: nothing on file says what the payer pays for it.
    expect(p.expectedCents).toBeNull();
    expect(p.unrated).toEqual([]);
    expect(p.feeWithoutRate).toEqual(["99490"]);
    expect(describePriceSource(p.lines[0]!)).toBe("the practice's fee $65.00; expected from the payer: unknown (no payer rate on file)");
    // CONTROL: without the fee it is unrated, as before.
    expect(priceCodes(["99490"], "NP_PA", []).unrated).toEqual(["99490"]);
  });

  it("carries the expected amount onto the draft, and warns of a fee with nothing to expect against", () => {
    const d = buildSuperbill({
      visit: { id: "v", patientId: "p", isTelehealth: false, cptCodesAssigned: ["99349", "99490"], icd10Codes: ["C34.12"], modifiers: [], dos: "2026-10-27" },
      patient: { id: "p", primaryPayerId: "pay", primaryMemberId: "M1" },
      provider: { npi: "1234567893", fullName: "Helen Okafor", tier: "MD", credential: "MD" },
      placeOfServiceCode: "12",
      payerRates: [rate("99349", 7013)],
      practiceFees: [{ code: "99349", feeCents: 15000 }, { code: "99490", feeCents: 6500 }],
    });
    expect(d.billedAmountCents).toBe(21500);
    // 99490 has no rate, so what the payer is expected to pay is unknown.
    expect(d.expectedAmountCents).toBeNull();
    expect(d.warnings.some((w) => w.includes("No payer rate on file for 99490"))).toBe(true);
    // CONTROL: with every line rated it is the rates' total.
    const rated = buildSuperbill({
      visit: { id: "v", patientId: "p", isTelehealth: false, cptCodesAssigned: ["99349"], icd10Codes: ["C34.12"], modifiers: [], dos: "2026-10-27" },
      patient: { id: "p", primaryPayerId: "pay", primaryMemberId: "M1" },
      provider: { npi: "1234567893", fullName: "Helen Okafor", tier: "MD", credential: "MD" },
      placeOfServiceCode: "12",
      payerRates: [rate("99349", 7013)],
      practiceFees: [{ code: "99349", feeCents: 15000 }],
    });
    expect([rated.billedAmountCents, rated.expectedAmountCents]).toEqual([15000, 7013]);
  });
});
