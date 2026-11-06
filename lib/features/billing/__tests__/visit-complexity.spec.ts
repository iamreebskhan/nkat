/**
 * G2211 to modifier B1 on 1 January 2027 (CMS-1848-F): which lines carry the
 * modifier, what a bill is told, and the price B1 sets for the visit line.
 * The rates are the seed's for Medicare OH 99350 and G0318 in 2027
 * (payer-rules-fee-schedules-full.sql: 5.69 total RVU, 6.27 with B1, at
 * $32.6286).
 */
import { describe, expect, it } from "vitest";

import { claimTo837, type ClaimSource } from "@/lib/features/clearinghouse/claim-837";
import { defaultSettings } from "@/lib/features/clearinghouse/connection-settings";
import { priceCodes, type PayerRate } from "@/lib/features/superbills/superbill-pure";

import { complexityModifier, lineModifiers, visitComplexityWarnings } from "../visit-complexity";

const rate99350: PayerRate = {
  code: "99350", rateCents: 18566, npPaRateCents: 15781, facilityRateCents: null,
  payerRuleId: "r-99350", rateBasis: "cms_pfs_national_non_facility", effectiveDate: "2027-01-01",
  modifierRates: {
    B1: { rateCents: 20458, npPaRateCents: 17389, facilityRateCents: null },
    B2: { rateCents: 22318, npPaRateCents: 18970, facilityRateCents: null },
  },
};
const rateG0318: PayerRate = {
  code: "G0318", rateCents: 3263, npPaRateCents: 2774, facilityRateCents: null,
  payerRuleId: "r-g0318", rateBasis: "cms_pfs_national_non_facility", effectiveDate: "2027-01-01",
};

describe("lineModifiers — B1 and B2 on the visit's own line", () => {
  it("puts B1 on 99350's line and on no add-on line, and 95 on every line as before", () => {
    expect(lineModifiers("99350", ["95", "B1"])).toEqual(["95", "B1"]);
    expect(lineModifiers("G0318", ["95", "B1"])).toEqual(["95"]);
    expect(lineModifiers("99497", ["B2"])).toEqual([]);
    expect(lineModifiers("99213", ["b1"])).toEqual(["b1"]);
  });

  it("CONTROL: leaves every other modifier where it was", () => {
    expect(lineModifiers("G0318", ["95", "25", "GT"])).toEqual(["95", "25", "GT"]);
  });
});

describe("complexityModifier", () => {
  it("prices with B2 over B1, whatever the case", () => {
    expect(complexityModifier(["95", "b1"])).toBe("B1");
    expect(complexityModifier(["B1", "B2"])).toBe("B2");
    expect(complexityModifier(["95"])).toBeNull();
  });
});

describe("visitComplexityWarnings", () => {
  it("tells a 2027 bill to take G2211 off and add B1", () => {
    const w = visitComplexityWarnings(["99350", "G2211"], [], "2027-01-15");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/G2211 is not billed for a date of service from 1 January 2027/);
  });

  it("CONTROL: says nothing of G2211 on a 2026 bill, or of B1 on a 2027 visit", () => {
    expect(visitComplexityWarnings(["99350", "G2211"], [], "2026-12-31")).toEqual([]);
    expect(visitComplexityWarnings(["99350", "G0318"], ["B1"], "2027-01-01")).toEqual([]);
  });

  it("tells a 2026 bill that B1 has not started", () => {
    expect(visitComplexityWarnings(["99350"], ["B1"], "2026-12-31")[0]).toMatch(/B1 starts on 1 January 2027/);
  });

  it("says when no line can carry the modifier, and when both are on the bill", () => {
    expect(visitComplexityWarnings(["99497"], ["B1"], "2027-02-01")[0]).toMatch(/this bill has none/);
    expect(visitComplexityWarnings(["99350"], ["B1", "B2"], "2027-02-01")).toEqual([
      expect.stringMatching(/Bill B1 or B2, not both/),
    ]);
  });
});

describe("priceCodes — B1 prices the 2027 visit line", () => {
  it("bills 99350 at its B1 rate and G0318 at its own, for a physician and for an NP", () => {
    const md = priceCodes(["99350", "G0318"], "MD", [rate99350, rateG0318], { modifiers: ["B1"], units: { G0318: 2 } });
    expect(md.lines.map((l) => [l.code, l.rateCents, l.modifier])).toEqual([
      ["99350", 20458, "B1"],
      ["G0318", 3263, undefined],
    ]);
    expect(md.totalCents).toBe(20458 + 2 * 3263);
    const np = priceCodes(["99350"], "NP_PA", [rate99350], { modifiers: ["B1"] });
    expect(np.lines[0]!.rateCents).toBe(17389);
    expect(priceCodes(["99350"], "MD", [rate99350], { modifiers: ["B2"] }).lines[0]!.rateCents).toBe(22318);
  });

  it("CONTROL: without B1, or on a rate with no modifier rates (2026), bills the visit's own rate", () => {
    expect(priceCodes(["99350"], "MD", [rate99350]).lines[0]!.rateCents).toBe(18566);
    const july2026 = { ...rate99350, rateCents: 19306, npPaRateCents: 16410, modifierRates: undefined };
    const p = priceCodes(["99350"], "MD", [july2026], { modifiers: ["B1"] });
    expect(p.lines[0]!.rateCents).toBe(19306);
    expect(p.lines[0]!.modifier).toBeUndefined();
  });

  it("charges the practice's own fee where it has one, expecting B1's rate from the payer", () => {
    const p = priceCodes(["99350"], "MD", [rate99350], { modifiers: ["B1"], fees: [{ code: "99350", feeCents: 30000 }] });
    expect(p.totalCents).toBe(30000);
    expect(p.expectedCents).toBe(20458);
  });
});

describe("claimTo837 — the modifier on the visit's line", () => {
  const claim: ClaimSource = {
    superbillId: "b2e303af-e2cb-4292-8d00-c35c07423a0d",
    claimRef: "B2E303AFE2CB",
    status: "ready_to_submit",
    dateOfService: "2027-01-15",
    placeOfService: "12",
    codes: ["99350", "G0318", "99497"],
    units: { G0318: 2 },
    modifiers: ["B1"],
    icd10: ["I50.9"],
    chargeCents: { "99350": 20458, G0318: 6526, "99497": 8125 },
    patient: { lastName: "Testcase", firstName: "Ruth", dob: "1941-03-02", sex: "F", address: { line1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215" } },
    memberId: "1EG4TE5MK72",
    groupNumber: null,
    payer: { id: "p1", name: "Medicare Ohio", type: "medicare_mac" },
    rendering: { name: "Helen Okafor", npi: "1245319599", taxonomy: "363LF0000X" },
    billing: {
      name: "Demo Palliative (test)", npi: "1234567893", ein: "123456789", taxonomy: "207QH0002X",
      address: { line1: "100 Main St", city: "Columbus", state: "OH", zip: "432151234" }, payTo: null,
    },
    priorPayerClaimNumber: null,
  };
  const ctx = { settings: defaultSettings("availity", "test"), vendorName: "Availity", payerId: { externalPayerId: "15202", claimFilingIndicator: null } };

  it("sends B1 on 99350's line only", () => {
    const m = claimTo837(claim, ctx);
    expect(m.stops).toEqual([]);
    expect(m.claim!.lines.map((l) => [l.code, l.modifiers])).toEqual([
      ["99350", ["B1"]],
      ["G0318", []],
      ["99497", []],
    ]);
  });

  it("CONTROL: a telehealth modifier still goes on every line", () => {
    const m = claimTo837({ ...claim, modifiers: ["95", "B1"] }, ctx);
    expect(m.claim!.lines.map((l) => l.modifiers)).toEqual([["95", "B1"], ["95"], ["95"]]);
  });
});
