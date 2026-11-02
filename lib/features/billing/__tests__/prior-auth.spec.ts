/**
 * Prior authorizations on the chart (0124): what one covers, the warning a
 * review gives, the note when booking, and the number on the claim.
 */
import { describe, expect, it, vi } from "vitest";

import { claimTo837, type ClaimSource } from "@/lib/features/clearinghouse/claim-837";
import { buildClaim837P } from "@/lib/features/clearinghouse/x12/x12-837p";
import { PriorAuthSchema } from "@/lib/features/patients/prior-auth.service";

import { priorAuthWarnings } from "../claim-checks";
import { CLAIM_EXPORT_COLUMNS, claimRows, type ClaimForExport } from "../claim-export";
import { authGapOn, coveringAuth, uncoveredCodes, type PriorAuth } from "../prior-auth";

vi.mock("@/lib/db", () => ({ withOrgContext: vi.fn() }));

const auth = (extra: Partial<PriorAuth> = {}): PriorAuth => ({
  id: "a", payerId: "pay", authNumber: "AUTH-1", codes: [], validFrom: "2026-10-01", validTo: "2026-12-31", visitsAuthorized: null, status: "active", ...extra,
});
const claim = { payerId: "pay", codes: ["99349", "99497"], dos: "2026-11-01" };

describe("coveringAuth", () => {
  it("takes the payer, the date and a code on the claim", () => {
    expect(coveringAuth([auth()], claim)?.authNumber).toBe("AUTH-1");
    expect(coveringAuth([auth({ codes: ["99497"] })], claim)?.authNumber).toBe("AUTH-1");
  });

  it("the first and last days are inside it", () => {
    expect(coveringAuth([auth()], { ...claim, dos: "2026-10-01" })).not.toBeNull();
    expect(coveringAuth([auth()], { ...claim, dos: "2026-12-31" })).not.toBeNull();
  });

  it.each([
    ["another plan", auth({ payerId: "other" })],
    ["before it starts", auth({ validFrom: "2026-11-02" })],
    ["after it ends", auth({ validTo: "2026-10-31" })],
    ["other codes", auth({ codes: ["99350"] })],
    ["withdrawn", auth({ status: "withdrawn" })],
  ])("does not cover: %s", (_n, a) => {
    expect(coveringAuth([a], claim)).toBeNull();
  });

  it("with two, the one covering more of the claim goes, then the later", () => {
    const one = auth({ authNumber: "ONE", codes: ["99349"] });
    const both = auth({ authNumber: "BOTH", codes: ["99349", "99497"] });
    expect(coveringAuth([one, both], claim)?.authNumber).toBe("BOTH");
    const older = auth({ authNumber: "OLDER", validFrom: "2026-01-01" });
    const newer = auth({ authNumber: "NEWER", validFrom: "2026-10-15" });
    expect(coveringAuth([older, newer], claim)?.authNumber).toBe("NEWER");
  });
});

describe("uncoveredCodes", () => {
  it("names the codes no live authorization covers", () => {
    expect(uncoveredCodes([auth({ codes: ["99349"] })], claim)).toEqual(["99497"]);
    expect(uncoveredCodes([auth()], claim)).toEqual([]);
    expect(uncoveredCodes([], claim)).toEqual(["99349", "99497"]);
  });
});

describe("priorAuthWarnings", () => {
  const base = { payerName: "Payer", dos: "2026-11-01" };

  it("warns on a code the payer firmly requires it for and none covers", () => {
    expect(priorAuthWarnings({ ...base, requiredCodes: ["99349"], uncovered: ["99349"] })).toEqual([
      { kind: "prior_auth", code: "99349", detail: "Payer requires prior authorization for 99349, and none on the chart covers 2026-11-01." },
    ]);
  });

  it("CONTROL: says nothing when it is covered, or when no firm rule asks", () => {
    expect(priorAuthWarnings({ ...base, requiredCodes: ["99349"], uncovered: [] })).toEqual([]);
    expect(priorAuthWarnings({ ...base, requiredCodes: [], uncovered: ["99349"] })).toEqual([]);
  });

  it("says when a capped authorization has run out", () => {
    const [w] = priorAuthWarnings({ ...base, requiredCodes: [], uncovered: [], overCap: { authNumber: "AUTH-1", visitsAuthorized: 1 } });
    expect(w!.detail).toBe("Authorization AUTH-1 allows 1 visit, and this claim goes past that.");
  });
});

describe("authGapOn, said when booking", () => {
  it("says nothing with none on file: most visits need none", () => {
    expect(authGapOn([], "2026-11-01")).toBeNull();
  });

  it("says nothing when one runs that day", () => {
    expect(authGapOn([auth()], "2026-11-01")).toBeNull();
  });

  it("says when the last one ended, or the next has not begun", () => {
    expect(authGapOn([auth()], "2027-01-05")).toBe("The prior authorization on file (AUTH-1) ended on 2026-12-31, before this visit.");
    expect(authGapOn([auth()], "2026-09-01")).toBe("The prior authorization on file (AUTH-1) starts on 2026-10-01, after this visit.");
  });

  it("CONTROL: a withdrawn one is not on file", () => {
    expect(authGapOn([auth({ status: "withdrawn" })], "2027-01-05")).toBeNull();
  });
});

describe("PriorAuthSchema", () => {
  const good = { payerId: "11111111-1111-4111-8111-111111111111", authNumber: "A-123", codes: ["99349"], validFrom: "2026-10-01", validTo: "2026-12-31", visitsAuthorized: 12 };

  it("takes a good one, and upper-cases its codes", () => {
    const r = PriorAuthSchema.safeParse({ ...good, codes: ["g0318"] });
    expect(r.success && r.data.codes).toEqual(["G0318"]);
  });

  it("refuses what a claim could not carry", () => {
    expect(PriorAuthSchema.safeParse({ ...good, authNumber: "A 123*" }).success).toBe(false);
    expect(PriorAuthSchema.safeParse({ ...good, authNumber: "" }).success).toBe(false);
    expect(PriorAuthSchema.safeParse({ ...good, codes: ["9934"] }).success).toBe(false);
    expect(PriorAuthSchema.safeParse({ ...good, validTo: "2026-09-30" }).success).toBe(false);
    expect(PriorAuthSchema.safeParse({ ...good, visitsAuthorized: 0 }).success).toBe(false);
  });
});

const source = (extra: Partial<ClaimSource> = {}): ClaimSource => ({
  superbillId: "s", claimRef: "ABC123", status: "denied", dateOfService: "2026-10-01", placeOfService: "12",
  codes: ["99350"], units: {}, modifiers: [], icd10: ["C34.90"], chargeCents: { "99350": 15000 },
  patient: { lastName: "Testcase", firstName: "Ruth", dob: "1950-01-01", sex: "F", address: { line1: "1 Main", city: "Columbus", state: "OH", zip: "43004" } },
  memberId: "M1", groupNumber: null, payer: { id: "p", name: "Payer", type: "medicare" },
  rendering: { name: "Helen Okafor", npi: "1679576722", taxonomy: null },
  billing: { name: "Practice", npi: "1234567893", ein: "123456789", taxonomy: "207RH0002X", address: { line1: "2 Main", city: "Columbus", state: "OH", zip: "430041234" }, payTo: null },
  priorPayerClaimNumber: "PCN1",
  ...extra,
});
const payerId = { externalPayerId: "X", claimFilingIndicator: null };
const file = (c: ClaimSource) =>
  buildClaim837P({
    controlNumber: "0001", reference: "1", now: new Date("2026-10-31T00:00:00Z"),
    claim: claimTo837(c, { settings: {} as never, vendorName: "Availity", payerId }).claim!,
    submitter: { id: "S", name: "S", contactName: "C", contactPhone: "6145551234", receiverName: "R", receiverId: "R" },
  });

describe("on the claim", () => {
  it("writes REF*G1 after CLM and before REF*F8 and HI, the TR3's order", () => {
    const s = file(source({ priorAuthNumber: "AUTH-1" }));
    const at = (p: string) => s.findIndex((x) => x.startsWith(p));
    expect(s[at("REF*G1")]).toContain("REF*G1*AUTH-1");
    expect(at("REF*G1")).toBeGreaterThan(at("CLM*"));
    expect(at("REF*G1")).toBeLessThan(at("REF*F8"));
    expect(at("REF*F8")).toBeLessThan(at("HI*"));
  });

  it("keeps a hyphen in the payer's own numbers: without it they name something else", () => {
    const s = file(source({ priorAuthNumber: "AUTH-1", priorPayerClaimNumber: "2026-00042" }));
    expect(s.find((x) => x.startsWith("REF*F8"))).toContain("REF*F8*2026-00042");
  });

  it("CONTROL: no authorization, no REF*G1", () => {
    expect(file(source()).some((x) => x.startsWith("REF*G1"))).toBe(false);
  });

  it("goes in the export's last column", () => {
    const c = {
      superbillId: "s", visitId: "v", claimRef: "ABC123", status: "submitted", dateOfService: "2026-10-01", placeOfService: "12",
      codes: ["99350"], units: {}, modifiers: [], icd10: ["C34.90"], chargeCents: { "99350": 15000 }, billedCents: 15000, expectedCents: null,
      patient: { lastName: "T", firstName: "R", dob: "1950-01-01", sex: "F", address: null }, payerName: "P", memberId: "M", groupNumber: null,
      secondary: null, rendering: { name: "H O", npi: "1", taxonomy: null }, billing: { name: "P", npi: "1", ein: "1", taxonomy: null, address: null, payTo: null },
    } satisfies ClaimForExport;
    expect(claimRows({ ...c, priorAuthNumber: "AUTH-1" })[0]![CLAIM_EXPORT_COLUMNS.indexOf("prior_auth_number")]).toBe("AUTH-1");
    expect(claimRows(c)[0]![CLAIM_EXPORT_COLUMNS.indexOf("prior_auth_number")]).toBe("");
  });
});
