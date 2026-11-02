/**
 * The referring physician on a claim (0123): off until the practice turns it
 * on, and on it names only a physician with a valid NPI. Box 17 filled with the
 * wrong provider is worse than box 17 left empty, so nothing here guesses.
 */
import { describe, expect, it, vi } from "vitest";

import { claimTo837, type ClaimSource } from "@/lib/features/clearinghouse/claim-837";
import { buildClaim837P, type Claim837 } from "@/lib/features/clearinghouse/x12/x12-837p";

import { BillingProviderSchema, readClaimReferring } from "../billing-provider.service";
import { CLAIM_EXPORT_COLUMNS, claimExportWarnings, claimRows, type ClaimForExport } from "../claim-export";
import { NO_REFERRING, claimReferring, referringName } from "../claim-referring";

vi.mock("@/lib/db", () => ({ withOrgContext: vi.fn() }));

const VALID_NPI = "1234567893";
const link = { fullName: "Dr. Alan Brooks", npi: VALID_NPI };

describe("claimReferring", () => {
  it("names nobody, and warns of nothing, while the practice leaves it off", () => {
    expect(claimReferring(false, link)).toEqual(NO_REFERRING);
    expect(claimReferring(false, undefined)).toEqual(NO_REFERRING);
  });

  it("names the chart's referring physician when on", () => {
    expect(claimReferring(true, link)).toEqual({
      provider: { fullName: "Dr. Alan Brooks", lastName: "Brooks", firstName: "Alan", npi: VALID_NPI },
      warning: null,
    });
  });

  it("leaves the box empty and says why, rather than guess", () => {
    expect(claimReferring(true, undefined)).toMatchObject({ provider: null, warning: expect.stringContaining("no referring physician on the chart") });
    expect(claimReferring(true, { ...link, npi: null })).toMatchObject({ provider: null, warning: expect.stringContaining("no NPI") });
    expect(claimReferring(true, { ...link, npi: "1234567890" })).toMatchObject({ provider: null, warning: expect.stringContaining("fails its check digit") });
    expect(claimReferring(true, { ...link, fullName: "  " })).toMatchObject({ provider: null, warning: expect.stringContaining("no name") });
  });

  it("every warning says where it is put right", () => {
    for (const r of [claimReferring(true, undefined), claimReferring(true, { ...link, npi: null })]) {
      expect(r.warning).toContain("Care team");
    }
  });
});

describe("referringName", () => {
  it.each([
    ["Dr. Alan Brooks", "Alan", "Brooks"],
    ["Dr Alan Brooks", "Alan", "Brooks"],
    ["doctor Alan Brooks", "Alan", "Brooks"],
    ["Claire Donnelly, MD", "Claire", "Donnelly"],
    ["Mary Ann O'Neil, DO", "Mary Ann", "O'Neil"],
    // CONTROL: a name that only starts like a title stays whole.
    ["Drew Barry", "Drew", "Barry"],
  ])("%s", (full, firstName, lastName) => {
    expect(referringName(full)).toEqual({ firstName, lastName });
  });
});

describe("readClaimReferring", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const tx = (rows: unknown[]) => {
    const queryRaw = vi.fn(() => Promise.resolve(rows));
    return { tx: { $queryRaw: queryRaw } as never, queryRaw };
  };

  it("reads nothing when off", async () => {
    const { tx: t, queryRaw } = tx([]);
    const r = await readClaimReferring(t, { orgId: ORG, on: false, patientIds: ["p1"] });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(r.get("p1")).toEqual(NO_REFERRING);
  });

  it("answers for every patient, linked or not", async () => {
    const { tx: t } = tx([{ patient_id: "p1", full_name: "Dr. Alan Brooks", npi: VALID_NPI }]);
    const r = await readClaimReferring(t, { orgId: ORG, on: true, patientIds: ["p1", "p2"] });
    expect(r.get("p1")?.provider?.lastName).toBe("Brooks");
    expect(r.get("p2")?.warning).toContain("no referring physician");
  });
});

describe("the setting", () => {
  const body = { legalName: "A", npi: VALID_NPI, ein: null, taxonomyCode: null, address: null, payTo: null };

  it("is optional, so an older form cannot switch it off by leaving it out", () => {
    expect(BillingProviderSchema.safeParse(body).success).toBe(true);
    expect(BillingProviderSchema.safeParse({ ...body, claimReferringProvider: true }).success).toBe(true);
    expect(BillingProviderSchema.safeParse({ ...body, claimReferringProvider: "yes" }).success).toBe(false);
  });
});

const source = (extra: Partial<ClaimSource> = {}): ClaimSource => ({
  superbillId: "s", claimRef: "ABC123", status: "ready_to_submit", dateOfService: "2026-10-01", placeOfService: "12",
  codes: ["99350"], units: {}, modifiers: [], icd10: ["C34.90"], chargeCents: { "99350": 15000 },
  patient: { lastName: "Testcase", firstName: "Ruth", dob: "1950-01-01", sex: "F", address: { line1: "1 Main", city: "Columbus", state: "OH", zip: "43004" } },
  memberId: "M1", groupNumber: null, payer: { id: "p", name: "Payer", type: "medicare" },
  rendering: { name: "Helen Okafor", npi: "1679576722", taxonomy: null },
  billing: { name: "Practice", npi: VALID_NPI, ein: "123456789", taxonomy: "207RH0002X", address: { line1: "2 Main", city: "Columbus", state: "OH", zip: "430041234" }, payTo: null },
  priorPayerClaimNumber: null,
  ...extra,
});
const settings = {} as never;
const payerId = { externalPayerId: "X", claimFilingIndicator: null };
const on = claimReferring(true, link);

describe("on the 837P (loop 2310A)", () => {
  const file = (claim: Claim837) =>
    buildClaim837P({
      controlNumber: "0001", reference: "1", now: new Date("2026-10-31T00:00:00Z"), claim,
      submitter: { id: "S", name: "S", contactName: "C", contactPhone: "6145551234", receiverName: "R", receiverId: "R" },
    });

  it("writes NM1*DN with the NPI, after the claim's HI and before the rendering provider", () => {
    const m = claimTo837(source({ referring: on }), { settings, vendorName: "Availity", payerId });
    expect(m.stops).toEqual([]);
    const segs = file(m.claim!);
    const dn = segs.findIndex((s) => s.startsWith("NM1*DN*"));
    expect(segs[dn]).toContain(`NM1*DN*1*BROOKS*ALAN****XX*${VALID_NPI}`);
    expect(dn).toBeGreaterThan(segs.findIndex((s) => s.startsWith("HI*")));
    expect(dn).toBeLessThan(segs.findIndex((s) => s.startsWith("NM1*82*")));
  });

  it("CONTROL: with the setting off the file has no 2310A at all", () => {
    for (const referring of [undefined, NO_REFERRING]) {
      const m = claimTo837(source({ referring }), { settings, vendorName: "Availity", payerId });
      expect(file(m.claim!).some((s) => s.startsWith("NM1*DN*"))).toBe(false);
    }
  });

  it("a claim with box 17 empty still goes, with the warning", () => {
    const m = claimTo837(source({ referring: claimReferring(true, undefined) }), { settings, vendorName: "Availity", payerId });
    expect(m.claim).not.toBeNull();
    expect(m.stops).toEqual([]);
    expect(m.warnings.join(" ")).toContain("no referring physician on the chart");
    expect(file(m.claim!).some((s) => s.startsWith("NM1*DN*"))).toBe(false);
  });
});

describe("on the claim export", () => {
  const claim = (referring?: ClaimForExport["referring"]): ClaimForExport => ({
    superbillId: "s", visitId: "v", claimRef: "ABC123", status: "ready_to_submit", dateOfService: "2026-10-01", placeOfService: "12",
    codes: ["99350"], units: {}, modifiers: [], icd10: ["C34.90"], chargeCents: { "99350": 15000 }, billedCents: 15000, expectedCents: null,
    patient: { lastName: "Testcase", firstName: "Ruth", dob: "1950-01-01", sex: "F", address: null },
    payerName: "Payer", memberId: "M1", groupNumber: null, secondary: null,
    rendering: { name: "Helen Okafor", npi: "1679576722", taxonomy: null },
    billing: { name: "P", npi: VALID_NPI, ein: "123456789", taxonomy: "207RH0002X", address: null, payTo: null },
    referring,
  });
  const col = (row: string[], name: (typeof CLAIM_EXPORT_COLUMNS)[number]) => row[CLAIM_EXPORT_COLUMNS.indexOf(name)];

  it("adds its columns last, so a template built on the others still lines up", () => {
    expect(CLAIM_EXPORT_COLUMNS.slice(-4)).toEqual(["claim_expected_amount", "referring_provider_name", "referring_npi", "prior_auth_number"]);
  });

  it("fills them only when box 17 is", () => {
    const [row] = claimRows(claim(on));
    expect(col(row!, "referring_provider_name")).toBe("Dr. Alan Brooks");
    expect(col(row!, "referring_npi")).toBe(VALID_NPI);
    const [off] = claimRows(claim(NO_REFERRING));
    expect(col(off!, "referring_provider_name")).toBe("");
    expect(col(off!, "referring_npi")).toBe("");
    expect(off).toHaveLength(CLAIM_EXPORT_COLUMNS.length);
  });

  it("reports an empty box 17 as a warning", () => {
    expect(claimExportWarnings(claim(claimReferring(true, undefined))).join(" ")).toContain("no referring physician");
    expect(claimExportWarnings(claim(NO_REFERRING)).join(" ")).not.toContain("referring");
  });
});
