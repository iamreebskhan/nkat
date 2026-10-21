import { describe, expect, it } from "vitest";

import {
  assignmentFromSuggestion,
  buildBands,
  suggestCodes,
} from "@/lib/features/visits/cpt-suggester";

import {
  buildSuperbill,
  describePriceSource,
  estimateRateCents,
  lineChargeCents,
  priceCodes,
  savedSuperbillWarnings,
  submissionStamp,
  withHomeVisitCode,
  type BuildSuperbillInput,
  type PayerRate,
  type PricedLine,
} from "../superbill-pure";

describe("estimateRateCents (Medicare 2025 rates)", () => {
  it("99349 MD = $119.75", () => {
    expect(estimateRateCents("99349", "MD")).toBe(11975);
  });

  it("99349 NP/PA = $101.79", () => {
    expect(estimateRateCents("99349", "NP_PA")).toBe(10179);
  });

  it("G0318 bills a physician above an NP/PA, like every other row (they were swapped)", () => {
    expect(estimateRateCents("G0318", "MD")).toBe(2938);
    expect(estimateRateCents("G0318", "NP_PA")).toBe(2497);
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
    // A real-format NPI (right check digit); a wrong one now warns.
    npi: "1234567893",
    fullName: "Jane NP",
    tier: "NP_PA",
  },
  // Recorded on the visit (audit R23); a missing one now warns.
  placeOfServiceCode: "12",
};

describe("buildSuperbill", () => {
  it("happy path with no payer rate on file — the reference table, and it says so", () => {
    const r = buildSuperbill(baseInput);
    expect(r.placeOfServiceCode).toBe("12"); // home
    expect(r.billedAmountCents).toBe(10179); // 99349 NP/PA reference rate
    expect(r.ratedCodes.map(({ code, rateCents, source }) => ({ code, rateCents, source }))).toEqual([
      { code: "99349", rateCents: 10179, source: "reference_table" },
    ]);
    expect(r.unratedCodes).toEqual([]);
    // The one thing to verify: the price is the reference table's, not the payer's.
    expect(r.warnings).toEqual([
      expect.stringContaining("priced from Pallio's 2025 Medicare reference table"),
    ]);
  });

  it("telehealth visit with no recorded place of service defaults to 10", () => {
    const r = buildSuperbill({
      ...baseInput,
      placeOfServiceCode: null,
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

describe("buildSuperbill — who the claim names (audit R40, R25)", () => {
  const withProvider = (p: Partial<BuildSuperbillInput["provider"]>): BuildSuperbillInput => ({
    ...baseInput,
    provider: { ...baseInput.provider, ...p },
  });

  it("carries the organization's NPI as billing provider, apart from the rendering NPI", () => {
    const r = buildSuperbill(
      withProvider({ billingNpi: "1497758544", npiSource: "clinician", credential: "NP" }),
    );
    expect(r.providerNpi).toBe("1234567893");
    expect(r.billingNpi).toBe("1497758544");
    expect(r.warnings.some((w) => /NPI|credential/.test(w))).toBe(false);
  });

  it("says so when the rendering NPI is the organization's stand-in", () => {
    const r = buildSuperbill(
      withProvider({ npi: "1497758544", billingNpi: "1497758544", npiSource: "organization" }),
    );
    expect(r.providerNpi).toBe("1497758544");
    expect(r.warnings.some((w) => w.includes("organization's NPI"))).toBe(true);
  });

  it("names the clinician and the fix when there is no rendering NPI", () => {
    const r = buildSuperbill(withProvider({ npi: "", npiSource: "none" }));
    expect(
      r.warnings.some((w) => w.includes("No NPI on file for Jane NP") && w.includes("Team page")),
    ).toBe(true);
  });

  it("catches a rendering NPI with a wrong check digit", () => {
    const r = buildSuperbill(withProvider({ npi: "1234567890" }));
    expect(r.warnings.some((w) => w.includes("check digit"))).toBe(true);
  });

  it("says which rate was used when the credential was never recorded", () => {
    const r = buildSuperbill(withProvider({ credential: null }));
    expect(r.warnings.some((w) => w.includes("credential isn't set") && w.includes("NP/PA"))).toBe(
      true,
    );
  });

  it("flags a credential that does not bill home E/M", () => {
    const r = buildSuperbill(withProvider({ credential: "RN" }));
    expect(r.warnings.some((w) => w.includes("recorded as RN"))).toBe(true);
  });

  it("prices a physician at the MD rate", () => {
    const r = buildSuperbill(withProvider({ tier: "MD", credential: "MD" }));
    expect(r.billedAmountCents).toBe(11975);
  });

  it("defaults the billing NPI to empty rather than undefined", () => {
    expect(buildSuperbill(baseInput).billingNpi).toBe("");
  });
});

describe("savedSuperbillWarnings", () => {
  const saved = {
    memberIdSnapshot: "M1",
    cptCodes: ["99349"],
    icd10Codes: ["C34.90"],
    providerNpi: "1234567893",
    providerName: "Jane NP",
    billingNpi: "1497758544",
  };

  it("is empty for a complete bill naming the clinician", () => {
    expect(savedSuperbillWarnings(saved)).toEqual([]);
  });

  it("flags a saved bill with no rendering NPI — the screen used to show nothing", () => {
    expect(savedSuperbillWarnings({ ...saved, providerNpi: "" }).join(" ")).toContain(
      "No NPI on file for Jane NP",
    );
  });

  it("flags a saved bill whose rendering NPI is the organization's", () => {
    expect(savedSuperbillWarnings({ ...saved, providerNpi: "1497758544" }).join(" ")).toContain(
      "organization's NPI",
    );
  });

  it("flags a missing member ID and diagnosis", () => {
    const w = savedSuperbillWarnings({ ...saved, memberIdSnapshot: "", icd10Codes: [] });
    expect(w.some((x) => x.includes("member ID"))).toBe(true);
    expect(w.some((x) => x.includes("ICD-10"))).toBe(true);
  });

  it("does not guess on bills saved before the billing NPI existed", () => {
    expect(savedSuperbillWarnings({ ...saved, billingNpi: null })).toEqual([]);
  });
});

const RATE = (code: string, dollars: number, extra: Partial<PayerRate> = {}): PayerRate => ({
  code,
  rateCents: Math.round(dollars * 100),
  npPaRateCents: null,
  facilityRateCents: null,
  payerRuleId: `rule-${code}`,
  rateBasis: "state_medicaid_ffs_non_facility_benchmark",
  effectiveDate: "2024-01-01",
  ...extra,
});

describe("priceCodes — the payer's rate first (audit R33)", () => {
  it("bills the payer's rate on file, not the reference table", () => {
    const p = priceCodes(["99349"], "NP_PA", [RATE("99349", 70.13)]);
    expect(p.totalCents).toBe(7013);
    expect(p.lines[0]).toMatchObject({
      code: "99349",
      rateCents: 7013,
      source: "payer_fee_schedule",
      payerRuleId: "rule-99349",
      effectiveDate: "2024-01-01",
    });
    expect(p.fromReference).toEqual([]);
  });

  it("uses a published NP/PA rate for an NP/PA, and the physician rate for an MD", () => {
    const r = [RATE("99342", 57.81, { npPaRateCents: 4624 })];
    expect(priceCodes(["99342"], "NP_PA", r).totalCents).toBe(4624);
    expect(priceCodes(["99342"], "MD", r).totalCents).toBe(5781);
  });

  it("falls back to the published rate when the payer lists no NP/PA rate", () => {
    expect(priceCodes(["99349"], "NP_PA", [RATE("99349", 70.13)]).totalCents).toBe(7013);
  });

  it("uses the facility rate at a facility place of service", () => {
    const r = [RATE("99214", 98.84, { npPaRateCents: 7907, facilityRateCents: 7523 })];
    expect(priceCodes(["99214"], "MD", r, { facility: true }).totalCents).toBe(7523);
    expect(priceCodes(["99214"], "MD", r).totalCents).toBe(9884);
  });

  it("falls back to the reference table line by line, and says which lines did", () => {
    const p = priceCodes(["99349", "99497"], "NP_PA", [RATE("99349", 70.13)]);
    expect(p.totalCents).toBe(7013 + 6381);
    expect(p.lines[1]).toMatchObject({ code: "99497", source: "reference_table", rateCents: 6381 });
    expect(p.fromReference).toEqual(["99497"]);
  });

  it("marks a code in neither as unrated, priced at 0", () => {
    const p = priceCodes(["X9999"], "NP_PA", []);
    expect(p.lines[0]).toMatchObject({ code: "X9999", rateCents: 0, source: "unrated" });
    expect(p.unrated).toEqual(["X9999"]);
    expect(p.totalCents).toBe(0);
  });
});

describe("buildSuperbill — pricing and place of service (audit R33, R23)", () => {
  it("prices from the payer and stores where each line came from, with nothing to verify", () => {
    const r = buildSuperbill({ ...baseInput, payerRates: [RATE("99349", 70.13)] });
    expect(r.billedAmountCents).toBe(7013);
    expect(r.pricing).toEqual({
      tier: "NP_PA",
      lines: [expect.objectContaining({ code: "99349", source: "payer_fee_schedule" })],
    });
    expect(r.warnings).toEqual([]);
  });

  it("says when there is no payer at all", () => {
    const r = buildSuperbill({ ...baseInput, patient: { ...baseInput.patient, primaryPayerId: null } });
    expect(r.warnings.some((w) => w.startsWith("No payer on file"))).toBe(true);
  });

  it("keeps a recorded place of service over the telehealth default, with no default warning", () => {
    const r = buildSuperbill({
      ...baseInput,
      payerRates: [RATE("99349", 70.13)],
      placeOfServiceCode: "12",
      visit: { ...baseInput.visit, isTelehealth: true, modifiers: ["95"] },
    });
    expect(r.placeOfServiceCode).toBe("12");
    expect(r.warnings.some((w) => w.includes("not recorded"))).toBe(false);
  });

  it("defaults an unrecorded place of service and says so", () => {
    const r = buildSuperbill({ ...baseInput, placeOfServiceCode: null });
    expect(r.placeOfServiceCode).toBe("12");
    expect(r.warnings.some((w) => w.includes("Place of service was not recorded"))).toBe(true);
  });

  it("flags a telehealth place of service on an in-person visit", () => {
    const r = buildSuperbill({ ...baseInput, placeOfServiceCode: "10" });
    expect(r.warnings.some((w) => w.includes("telehealth code"))).toBe(true);
  });

  it("prices a facility place of service at the facility rate", () => {
    const r = buildSuperbill({
      ...baseInput,
      placeOfServiceCode: "31",
      posFacility: true,
      payerRates: [RATE("99349", 70.13, { facilityRateCents: 5500 })],
    });
    expect(r.billedAmountCents).toBe(5500);
  });
});

/**
 * Units reach the price (0106). A claim line is one code, its units and a
 * charge of units × the per-unit rate (CMS-1500 24F/24G), so an add-on that
 * ran three increments bills three rates. Every add-on used to bill one.
 */
describe("pricing × units", () => {
  it("CONTROL: bills G0318 × 3 at three NP/PA reference rates, and the line says so", () => {
    const r = buildSuperbill({
      ...baseInput,
      visit: { ...baseInput.visit, cptCodesAssigned: ["99350", "G0318"], cptUnits: { G0318: 3 } },
    });
    // 99350 NP/PA 14834 + 3 × G0318 NP/PA 2497. One unit billed 17331.
    expect(r.billedAmountCents).toBe(14834 + 3 * 2497);
    expect(r.cptUnits).toEqual({ G0318: 3 });
    expect(r.pricing.lines.find((l) => l.code === "G0318")).toMatchObject({
      units: 3,
      rateCents: 2497,
      chargeCents: 7491,
    });
    expect(r.pricing.lines.find((l) => l.code === "99350")).toMatchObject({
      units: 1,
      rateCents: 14834,
      chargeCents: 14834,
    });
  });

  it("multiplies the payer's rate by units, and keeps the rate per unit", () => {
    const p = priceCodes(["99350", "99417"], "NP_PA", [RATE("99350", 101.86), RATE("99417", 23.83)], {
      units: { "99417": 2 },
    });
    expect(p.lines[1]).toMatchObject({ code: "99417", units: 2, rateCents: 2383, chargeCents: 4766 });
    expect(p.totalCents).toBe(10186 + 4766);
  });

  it("multiplies the facility rate by units", () => {
    const p = priceCodes(["99417"], "MD", [RATE("99417", 23.83, { facilityRateCents: 1800 })], {
      facility: true,
      units: { "99417": 3 },
    });
    expect(p.lines[0]).toMatchObject({ rateCents: 1800, units: 3, chargeCents: 5400 });
    expect(p.totalCents).toBe(5400);
  });

  it("charges nothing for an unrated line", () => {
    const unrated = priceCodes(["X9999"], "MD", [], { units: { X9999: 3 } });
    expect(unrated.lines[0]).toMatchObject({ source: "unrated", rateCents: 0, chargeCents: 0 });
    expect(unrated.totalCents).toBe(0);
  });

  it("CONTROL: prices a code listed twice once, at its units", () => {
    // The codes are a set wherever the bill is printed or compared (formatCodes,
    // the packet's reconcile), so a repeat can only arrive through the API. It
    // was priced twice: G0318 × 8 billed beside a bill printing "G0318 ×4".
    const p = priceCodes(["99350", "G0318", "G0318"], "NP_PA", [], { units: { G0318: 4 } });
    expect(p.totalCents).toBe(14834 + 4 * 2497);
    expect(p.lines.map((l) => [l.code, l.units])).toEqual([
      ["99350", 1],
      ["G0318", 4],
    ]);
  });

  it("never prices units onto a code billed once per visit", () => {
    // A home E/M is reported once per date of service. The writers refuse
    // such units; pricing does not trust that they always will.
    const p = priceCodes(["99350"], "NP_PA", [], { units: { "99350": 2 } });
    expect(p.lines[0]).toMatchObject({ units: 1, chargeCents: 14834 });
    expect(p.totalCents).toBe(14834);
  });

  it("reads a line saved before 0106, with no units or charge, as one unit at its rate", () => {
    const legacy = { code: "99417", rateCents: 2475, source: "reference_table" } as PricedLine;
    expect(lineChargeCents(legacy)).toBe(2475);
    expect(lineChargeCents({ ...legacy, units: 2 })).toBe(4950);
    expect(lineChargeCents({ ...legacy, units: 2, chargeCents: 4950 })).toBe(4950);
  });

  it("warns above Pallio's G0318 cap on the draft, and not at it", () => {
    const at = (n: number) =>
      buildSuperbill({
        ...baseInput,
        visit: { ...baseInput.visit, cptCodesAssigned: ["99350", "G0318"], cptUnits: { G0318: n } },
      }).warnings.filter((w) => w.includes("Pallio allows"));
    expect(at(5)).toHaveLength(1);
    expect(at(4)).toEqual([]);
  });

  it("warns above the cap on a saved bill too", () => {
    const saved = {
      memberIdSnapshot: "M1",
      cptCodes: ["99350", "G0318"],
      icd10Codes: ["C34.90"],
      providerNpi: "1234567893",
      providerName: "Jane NP",
      billingNpi: "1497758544",
    };
    expect(savedSuperbillWarnings({ ...saved, cptUnits: { G0318: 5 } }).join(" ")).toContain(
      "G0318 is billed at 5 units",
    );
    expect(savedSuperbillWarnings({ ...saved, cptUnits: { G0318: 4 } })).toEqual([]);
  });

  it("carries the count from the suggester to the bill: 140 Medicare minutes bill G0318 × 3", () => {
    // The whole chain, pure: the same functions the document page and the
    // bill run. 140 minutes is 45 past the CMS 95-minute total for 99350.
    const BANDS = {
      newPatientHome: buildBands([
        { code: "99341", typicalMinutes: 15 },
        { code: "99342", typicalMinutes: 30 },
        { code: "99344", typicalMinutes: 60 },
        { code: "99345", typicalMinutes: 75 },
      ]),
      establishedPatientHome: buildBands([
        { code: "99347", typicalMinutes: 20 },
        { code: "99348", typicalMinutes: 30 },
        { code: "99349", typicalMinutes: 40 },
        { code: "99350", typicalMinutes: 60 },
      ]),
    };
    const assignment = assignmentFromSuggestion(
      suggestCodes({
        bands: BANDS,
        visitType: "established_patient_home",
        totalMinutes: 140,
        payerCategory: "medicare",
      }),
    );
    const r = buildSuperbill({
      ...baseInput,
      visit: { ...baseInput.visit, cptCodesAssigned: assignment.codes, cptUnits: assignment.units },
      provider: { ...baseInput.provider, tier: "MD" },
    });
    expect(r.cptCodes).toEqual(["99350", "G0318"]);
    expect(r.billedAmountCents).toBe(17452 + 3 * 2938);
  });
});

describe("describePriceSource", () => {
  it("names the payer's basis and effective date", () => {
    expect(describePriceSource(priceCodes(["99349"], "NP_PA", [RATE("99349", 70.13)]).lines[0]!)).toBe(
      "payer rate — state Medicaid fee schedule (non-facility), effective 2024-01-01",
    );
  });

  it("tells the biller to verify a reference-table price", () => {
    expect(describePriceSource(priceCodes(["99349"], "NP_PA", []).lines[0]!)).toMatch(/reference table — verify/);
  });
});

describe("submissionStamp (audit R26)", () => {
  it("stamps a draft as not reviewed", () => {
    expect(submissionStamp("draft")).toBe("DRAFT — not reviewed for submission");
  });

  it("does not stamp a reviewed or submitted bill", () => {
    expect(submissionStamp("ready_to_submit")).toBeNull();
    expect(submissionStamp("submitted")).toBeNull();
  });
});

/**
 * "Use this code" on the bill page's Time spent panel. It appended its
 * suggestion, so on localhost one click turned a bill of 99342 + 99497 into
 * 99342 + 99497 + 99349 — two home E/M codes for one visit — and the autosave
 * repriced it from $142.64 to $274.91.
 */
describe("withHomeVisitCode — one home E/M code per bill", () => {
  it("puts the code in the place of the bill's home E/M code", () => {
    expect(withHomeVisitCode(["99342", "99497"], "99341")).toEqual(["99341", "99497"]);
  });

  it("replaces a home code from the other ladder too", () => {
    expect(withHomeVisitCode(["99348", "99497"], "99341")).toEqual(["99341", "99497"]);
  });

  it("drops any further home E/M codes already on the bill", () => {
    expect(withHomeVisitCode(["99342", "99497", "99349"], "99341")).toEqual(["99341", "99497"]);
  });

  it("leaves the add-ons alone", () => {
    expect(withHomeVisitCode(["99350", "G0318", "99497", "99498"], "99349")).toEqual([
      "99349",
      "G0318",
      "99497",
      "99498",
    ]);
  });

  it("CONTROL: adds the code to a bill that has no home E/M code", () => {
    expect(withHomeVisitCode(["99497"], "99347")).toEqual(["99497", "99347"]);
    expect(withHomeVisitCode([], "99347")).toEqual(["99347"]);
  });

  it("CONTROL: the code already on the bill stays once", () => {
    expect(withHomeVisitCode(["99349", "99497"], "99349")).toEqual(["99349", "99497"]);
  });
});
