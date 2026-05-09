import { describe, expect, it } from "vitest";

import {
  buildSuperbill,
  estimateRateCents,
  type BuildSuperbillInput,
} from "../superbill-pure";

describe("estimateRateCents (Medicare 2025 rates)", () => {
  it("99349 MD = $119.75", () => {
    expect(estimateRateCents("99349", "MD")).toBe(11975);
  });

  it("99349 NP/PA = $101.79", () => {
    expect(estimateRateCents("99349", "NP_PA")).toBe(10179);
  });

  it("G0318 has separate Medicare rate", () => {
    expect(estimateRateCents("G0318", "MD")).toBe(2497);
  });

  it("unknown code returns 0 (caller flags as 'verify rate')", () => {
    expect(estimateRateCents("99999", "MD")).toBe(0);
    expect(estimateRateCents("UNKNOWN", "NP_PA")).toBe(0);
  });
});

const baseInput: BuildSuperbillInput = {
  visit: {
    id: "v1",
    patientId: "p1",
    isTelehealth: false,
    cptCodesAssigned: ["99349"],
    icd10Codes: ["G62.9"],
    modifiers: [],
    dos: "2026-05-15",
  },
  patient: {
    id: "p1",
    primaryPayerId: "00000000-0000-0000-0000-000000000aaa",
    primaryMemberId: "MEM12345",
  },
  provider: {
    npi: "1234567890",
    fullName: "Jane NP",
    tier: "NP_PA",
  },
};

describe("buildSuperbill", () => {
  it("happy path — single CPT, NP/PA tier, in-home", () => {
    const r = buildSuperbill(baseInput);
    expect(r.placeOfServiceCode).toBe("12"); // home
    expect(r.billedAmountCents).toBe(10179); // 99349 NP/PA rate
    expect(r.ratedCodes).toEqual([{ code: "99349", rateCents: 10179 }]);
    expect(r.unratedCodes).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("telehealth visit defaults POS=10 (telehealth provided in patient home)", () => {
    const r = buildSuperbill({
      ...baseInput,
      visit: { ...baseInput.visit, isTelehealth: true, modifiers: ["95"] },
    });
    expect(r.placeOfServiceCode).toBe("10");
  });

  it("warns when telehealth visit is missing 95 or 93 modifier", () => {
    const r = buildSuperbill({
      ...baseInput,
      visit: { ...baseInput.visit, isTelehealth: true },
    });
    expect(r.warnings.find((w) => w.includes("modifier"))).toBeTruthy();
  });

  it("warns when patient has no member ID", () => {
    const r = buildSuperbill({
      ...baseInput,
      patient: { ...baseInput.patient, primaryMemberId: null },
    });
    expect(r.warnings.find((w) => w.includes("member ID"))).toBeTruthy();
  });

  it("warns when ICD-10 list is empty", () => {
    const r = buildSuperbill({
      ...baseInput,
      visit: { ...baseInput.visit, icd10Codes: [] },
    });
    expect(r.warnings.find((w) => w.includes("ICD-10"))).toBeTruthy();
  });

  it("warns when CPT list is empty", () => {
    const r = buildSuperbill({
      ...baseInput,
      visit: { ...baseInput.visit, cptCodesAssigned: [] },
    });
    expect(r.warnings.find((w) => w.includes("CPT"))).toBeTruthy();
  });

  it("sums billed amount across multiple CPTs", () => {
    const r = buildSuperbill({
      ...baseInput,
      visit: {
        ...baseInput.visit,
        cptCodesAssigned: ["99349", "99497"], // visit + ACP first 30
      },
    });
    // 99349 NP/PA = 10179, 99497 NP/PA = 6381
    expect(r.billedAmountCents).toBe(10179 + 6381);
    expect(r.ratedCodes).toHaveLength(2);
  });

  it("flags codes without rate-table entries in unratedCodes + a warning", () => {
    const r = buildSuperbill({
      ...baseInput,
      visit: {
        ...baseInput.visit,
        cptCodesAssigned: ["99349", "X9999"],
      },
    });
    expect(r.unratedCodes).toEqual(["X9999"]);
    expect(r.warnings.find((w) => w.includes("X9999"))).toBeTruthy();
    expect(r.billedAmountCents).toBe(10179); // unrated is excluded
  });

  it("uses MD rate when provider.tier=MD", () => {
    const r = buildSuperbill({
      ...baseInput,
      provider: { ...baseInput.provider, tier: "MD" },
    });
    expect(r.billedAmountCents).toBe(11975); // 99349 MD rate
  });
});
