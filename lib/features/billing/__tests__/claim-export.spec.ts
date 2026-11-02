/**
 * The claim-line export (0118; doc:72; Mark Q1 default) and the review checks
 * (doc:71; Mark Q5 default). Pure.
 */
import { describe, expect, it } from "vitest";

import {
  CLAIM_EXPORT_COLUMNS,
  claimExportWarnings,
  claimHardStops,
  claimRows,
  claimsCsv,
  csvCell,
  type ClaimForExport,
} from "../claim-export";
import { mueWarnings, notCoveredWarnings, ptpWarnings, zeroChargeWarnings } from "../claim-checks";

const claim = (over: Partial<ClaimForExport> = {}): ClaimForExport => ({
  superbillId: "5b000000-0000-4000-8000-000000000001",
  visitId: "0e000000-0000-4000-8000-000000000001",
  claimRef: "5B000000",
  status: "ready_to_submit",
  dateOfService: "2026-10-27",
  placeOfService: "12",
  codes: ["99349", "G0318"],
  units: { G0318: 2 },
  modifiers: ["95"],
  icd10: ["C34.12", "I50.9"],
  chargeCents: { "99349": 15000, G0318: 6000 },
  billedCents: 21000,
  expectedCents: 13800,
  patient: {
    lastName: "Testcase", firstName: "Ruth", dob: "1941-05-12", sex: "F",
    address: { line1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215" },
  },
  payerName: "CareSource Ohio",
  memberId: "CS-TEST-0042",
  groupNumber: null,
  secondary: null,
  rendering: { name: "Helen Okafor", npi: "1234567893", taxonomy: "207RH0002X" },
  billing: {
    name: "Demo Palliative (test)", npi: "1234567893", ein: "123456789", taxonomy: "193200000X",
    address: { line1: "1 Main St", line2: "Suite 2", city: "Columbus", state: "OH", zip: "432151234" }, payTo: null,
  },
  ...over,
});

const col = (row: string[], name: (typeof CLAIM_EXPORT_COLUMNS)[number]) => row[CLAIM_EXPORT_COLUMNS.indexOf(name)];

describe("the claim lines", () => {
  it("writes one row per service line, the claim's fields on each, in the CMS-1500's terms", () => {
    const rows = claimRows(claim());
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toHaveLength(CLAIM_EXPORT_COLUMNS.length);
    const [em, prolonged] = rows as [string[], string[]];
    expect(col(em, "cpt_hcpcs")).toBe("99349");
    expect(col(em, "units")).toBe("1");
    expect(col(em, "line_charge")).toBe("150.00");
    expect(col(prolonged, "cpt_hcpcs")).toBe("G0318");
    expect(col(prolonged, "units")).toBe("2");
    expect(col(prolonged, "line_charge")).toBe("60.00");
    expect(col(em, "modifier_1")).toBe("95");
    expect(col(em, "diagnosis_pointer")).toBe("AB");
    expect(col(em, "icd10_1")).toBe("C34.12");
    expect(col(em, "icd10_2")).toBe("I50.9");
    expect(col(em, "billing_ein")).toBe("123456789");
    expect(col(em, "billing_address_2")).toBe("Suite 2");
    expect(col(em, "claim_total_charge")).toBe("210.00");
    expect(col(em, "claim_expected_amount")).toBe("138.00");
    expect(col(em, "line")).toBe("1");
    expect(col(prolonged, "line")).toBe("2");
  });

  it("caps diagnoses at the claim's twelve and pointers at four", () => {
    const many = Array.from({ length: 14 }, (_, i) => `Z${String(i).padStart(2, "0")}.0`);
    const [r] = claimRows(claim({ icd10: many }));
    expect(col(r!, "icd10_12")).toBe("Z11.0");
    expect(r!.join("|")).not.toContain("Z12.0");
    expect(col(r!, "diagnosis_pointer")).toBe("ABCD");
    expect(claimExportWarnings(claim({ icd10: many }))).toContain("14 diagnoses; a claim carries 12");
  });
});

describe("the CSV", () => {
  it("quotes what needs quoting and neutralises a leading formula character", () => {
    expect(csvCell("O'Brien, Jr")).toBe('"O\'Brien, Jr"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // CONTROL: ordinary values pass through as they are.
    expect(csvCell("2026-10-27")).toBe("2026-10-27");
    expect(csvCell("99349")).toBe("99349");
  });

  it("starts with the header, ends every row with CRLF, and counts the lines", () => {
    const { csv, lines } = claimsCsv([claim(), claim({ superbillId: "5b000000-0000-4000-8000-000000000002", codes: ["99350"], units: {}, chargeCents: { "99350": 20000 } })]);
    expect(lines).toBe(3);
    const out = csv.split("\r\n");
    expect(out[0]).toBe(CLAIM_EXPORT_COLUMNS.join(","));
    expect(out).toHaveLength(5); // header, three lines, the trailing empty after the last CRLF
    expect(out[4]).toBe("");
  });
});

describe("hard stops and warnings (Mark Q5 default)", () => {
  it("stops a claim with no member ID, no diagnosis or no CPT code, and nothing else", () => {
    expect(claimHardStops(claim({ memberId: " ", icd10: [], codes: [] }))).toEqual(["no member ID", "no diagnosis", "no CPT code"]);
    // CONTROL: a claim that lacks only what the billing software fills is not stopped.
    expect(claimHardStops(claim({ billing: { ...claim().billing, ein: null, address: null } }))).toEqual([]);
  });

  it("warns of what the billing software will want", () => {
    expect(
      claimExportWarnings(claim({ billing: { ...claim().billing, ein: null, taxonomy: null, address: null }, billedCents: 0 })),
    ).toEqual(["no EIN", "no billing address", "no billing taxonomy", "billed $0.00"]);
    expect(claimExportWarnings(claim({ patient: { ...claim().patient, sex: null, address: null } }))).toEqual([
      "no patient address",
      "no patient sex",
    ]);
    expect(claimExportWarnings(claim())).toEqual([]);
  });

  it("writes the patient's sex as a claim takes it: F, M or U", () => {
    const sexOf = (sex: string | null) => col(claimRows(claim({ patient: { ...claim().patient, sex } }))[0]!, "patient_sex");
    expect([sexOf("F"), sexOf("M"), sexOf("X"), sexOf("unknown"), sexOf(null)]).toEqual(["F", "M", "U", "U", ""]);
    // CONTROL: X and unknown are recorded, so only nothing at all is a warning.
    expect(claimExportWarnings(claim({ patient: { ...claim().patient, sex: "X" } }))).toEqual([]);
  });
});

describe("the review checks", () => {
  const edits = [
    { column1: "99349", column2: "99497", modifierIndicator: 1 as const },
    { column1: "99349", column2: "99348", modifierIndicator: 0 as const },
    { column1: "99490", column2: "99491", modifierIndicator: 9 as const },
  ];

  it("reports an NCCI pair no modifier separates, and one that needs a modifier", () => {
    const w = ptpWarnings(["99349", "99348", "99497"], [], edits);
    expect(w.map((x) => x.code)).toEqual(["99497", "99348"]);
    expect(w[0]!.detail).toMatch(/only with an NCCI-associated modifier/);
    expect(w[1]!.detail).toMatch(/no modifier separates/);
  });

  it("says a bypass modifier on the bill may separate a modifier-1 pair, never a modifier-0 one", () => {
    const w = ptpWarnings(["99349", "99348", "99497"], ["25"], edits);
    expect(w.find((x) => x.code === "99497")!.detail).toMatch(/modifier 25 may separate/);
    expect(w.find((x) => x.code === "99348")!.detail).toMatch(/no modifier separates/);
  });

  it("CONTROL: a pair with only one of its codes on the claim, or indicator 9, is no warning", () => {
    expect(ptpWarnings(["99349"], [], edits)).toEqual([]);
    expect(ptpWarnings(["99490", "99491"], [], edits)).toEqual([]);
  });

  it("reports units above an MUE, a $0 line and a code the payer does not cover", () => {
    expect(mueWarnings(["G0318"], { G0318: 5 }, [{ code: "G0318", unitsMax: 4 }])[0]!.detail).toBe(
      "G0318 × 5 is above its NCCI medically unlikely edit of 4 per day.",
    );
    expect(mueWarnings(["G0318"], { G0318: 4 }, [{ code: "G0318", unitsMax: 4 }])).toEqual([]);
    expect(zeroChargeWarnings([{ code: "99490", chargeCents: 0 }, { code: "99349", chargeCents: 7013 }]).map((w) => w.code)).toEqual(["99490"]);
    expect(notCoveredWarnings([{ code: "99490", payerName: "CareSource Ohio" }])[0]!.detail).toBe(
      "CareSource Ohio's schedule lists 99490 as not covered.",
    );
  });
});
