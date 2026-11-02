/**
 * The 837P (0120): built, then read back segment by segment, against what the
 * 005010X222A1 TR3 requires in each loop. A claim the clearinghouse cannot
 * read comes back on a 999 days later; these hold the shape here.
 */
import { describe, expect, it } from "vitest";

import { buildClaim837P, type Claim837, type Submitter837 } from "../x12-837p";
import { readX12, type X12Segment } from "../x12-read";
import { wrapInterchange } from "../x12-write";

const submitter: Submitter837 = {
  id: "AV09311993",
  name: "Demo Palliative (test)",
  contactName: "Billing Office",
  contactPhone: "(614) 555-0100",
  contactEmail: null,
  receiverName: "AVAILITY LLC",
  receiverId: "030240928",
};

const claim: Claim837 = {
  claimRef: "B2E303AFE2CB",
  frequency: "1",
  placeOfService: "12",
  dateOfService: "2026-10-27",
  diagnoses: ["I50.9", "C34.12", "R06.00"],
  lines: [
    { code: "99350", modifiers: ["25"], units: 1, chargeCents: 22713, diagnosisPointers: [1, 2, 3] },
    { code: "G0318", modifiers: [], units: 2, chargeCents: 6240, diagnosisPointers: [1] },
  ],
  billing: {
    name: "Demo Palliative (test)",
    npi: "1234567893",
    ein: "12-3456789",
    taxonomy: "207QH0002X",
    address: { line1: "100 Main St", line2: "Suite 2", city: "Columbus", state: "OH", zip: "43215-1234" },
    payTo: null,
  },
  rendering: { lastName: "Okafor", firstName: "Helen", npi: "1003000126", taxonomy: "363LF0000X" },
  subscriber: {
    lastName: "Testcase",
    firstName: "Ruth",
    memberId: "1EG4-TE5-MK72",
    dob: "1941-03-02",
    sex: "F",
    address: { line1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215" },
    groupNumber: null,
  },
  payer: { name: "Medicare Ohio", id: "15202", filingIndicator: "MB" },
};

function build(c: Claim837 = claim) {
  const set = buildClaim837P({ controlNumber: "0001", reference: "S1-0001", now: new Date("2026-10-29T14:05:00Z"), submitter, claim: c });
  const file = wrapInterchange(
    {
      senderQualifier: "ZZ", senderId: submitter.id, receiverQualifier: "01", receiverId: "030240928",
      gsSenderCode: submitter.id, gsReceiverCode: "030240928", usage: "T", interchangeControlNumber: 77,
      groupControlNumber: 78, functionalId: "HC", version: "005010X222A1", now: new Date("2026-10-29T14:05:00Z"),
    },
    [set],
  );
  return { set, file, doc: readX12(file) };
}

const els = (s: X12Segment | undefined) => s?.elements.slice(1) ?? [];
const find = (segs: X12Segment[], tag: string, first?: string) =>
  segs.filter((s) => s.tag === tag && (first === undefined || s.elements[1] === first));

describe("buildClaim837P", () => {
  it("writes every loop in TR3 order", () => {
    const { doc } = build();
    const tags = doc.segments.map((s) => `${s.tag}${["NM1", "HL", "REF", "DTP", "PRV"].includes(s.tag) ? `*${s.elements[1]}` : ""}`);
    expect(tags).toEqual([
      "ISA", "GS", "ST", "BHT",
      "NM1*41", "PER", "NM1*40",
      "HL*1", "PRV*BI", "NM1*85", "N3", "N4", "REF*EI",
      "HL*2", "SBR", "NM1*IL", "N3", "N4", "DMG", "NM1*PR",
      "CLM", "HI", "NM1*82", "PRV*PE",
      "LX", "SV1", "DTP*472", "REF*6R",
      "LX", "SV1", "DTP*472", "REF*6R",
      "SE", "GE", "IEA",
    ]);
  });

  it("counts SE from ST to SE", () => {
    const { set, doc } = build();
    const se = find(doc.segments, "SE")[0]!;
    expect(els(se)).toEqual([String(set.length), "0001"]);
  });

  it("totals CLM02 from its lines and carries POS, frequency and the signatures", () => {
    const { doc } = build();
    expect(els(find(doc.segments, "CLM")[0])).toEqual(["B2E303AFE2CB", "289.53", "", "", "12:B:1", "Y", "A", "Y", "Y"]);
  });

  it("writes diagnoses without the decimal point, principal first", () => {
    const { doc } = build();
    expect(els(find(doc.segments, "HI")[0])).toEqual(["ABK:I509", "ABF:C3412", "ABF:R0600"]);
  });

  it("writes each line with its modifiers, units, pointers, date and a control number", () => {
    const { doc } = build();
    const sv1 = find(doc.segments, "SV1");
    expect(els(sv1[0])).toEqual(["HC:99350:25", "227.13", "UN", "1", "", "", "1:2:3"]);
    expect(els(sv1[1])).toEqual(["HC:G0318", "62.4", "UN", "2", "", "", "1"]);
    expect(find(doc.segments, "DTP", "472").map((s) => s.elements[3])).toEqual(["20261027", "20261027"]);
    expect(find(doc.segments, "REF", "6R").map((s) => s.elements[2])).toEqual(["B2E303AFE2CBL1", "B2E303AFE2CBL2"]);
  });

  it("names the billing provider with a nine-digit ZIP and the EIN without its hyphen", () => {
    const { doc } = build();
    expect(els(find(doc.segments, "NM1", "85")[0])).toEqual(["85", "2", "DEMO PALLIATIVE (TEST)", "", "", "", "", "XX", "1234567893"]);
    expect(els(find(doc.segments, "N4")[0])).toEqual(["COLUMBUS", "OH", "432151234"]);
    expect(els(find(doc.segments, "REF", "EI")[0])).toEqual(["EI", "123456789"]);
  });

  it("writes the patient as the subscriber with their member ID, address and DMG", () => {
    const { doc } = build();
    expect(els(find(doc.segments, "SBR")[0])).toEqual(["P", "18", "", "", "", "", "", "", "MB"]);
    expect(els(find(doc.segments, "NM1", "IL")[0])).toEqual(["IL", "1", "TESTCASE", "RUTH", "", "", "", "MI", "1EG4TE5MK72"]);
    expect(els(find(doc.segments, "DMG")[0])).toEqual(["D8", "19410302", "F"]);
    expect(els(find(doc.segments, "NM1", "PR")[0])).toEqual(["PR", "2", "MEDICARE OHIO", "", "", "", "", "PI", "15202"]);
  });

  it("carries the submitter contact (PER needs a number)", () => {
    const { doc } = build();
    expect(els(find(doc.segments, "PER")[0])).toEqual(["IC", "BILLING OFFICE", "TE", "6145550100"]);
    expect(() => build()).not.toThrow();
    expect(() =>
      buildClaim837P({ controlNumber: "0001", reference: "R", now: new Date(), submitter: { ...submitter, contactPhone: null }, claim }),
    ).toThrow(/phone number or an email/);
  });

  it("a replacement names the claim it replaces (REF*F8) and says frequency 7", () => {
    const { doc } = build({ ...claim, frequency: "7", originalClaimNumber: "26300123456789" });
    expect(find(doc.segments, "CLM")[0]!.elements[5]).toBe("12:B:7");
    expect(els(find(doc.segments, "REF", "F8")[0])).toEqual(["F8", "26300123456789"]);
    expect(() => build({ ...claim, frequency: "7", originalClaimNumber: null })).toThrow(/replaces/);
  });

  it("writes the pay-to loop only when payment goes elsewhere", () => {
    expect(find(build().doc.segments, "NM1", "87")).toHaveLength(0);
    const withPayTo = build({
      ...claim,
      billing: { ...claim.billing, payTo: { line1: "PO Box 9", city: "Columbus", state: "OH", zip: "43216" } },
    });
    expect(find(withPayTo.doc.segments, "NM1", "87")).toHaveLength(1);
  });

  it("refuses what no payer could read", () => {
    expect(() => build({ ...claim, billing: { ...claim.billing, address: { ...claim.billing.address, zip: "43215" } } })).toThrow(/ZIP 5 digits where 9/);
    expect(() => build({ ...claim, diagnoses: [] })).toThrow(/1 to 12 diagnoses/);
    expect(() => build({ ...claim, lines: [] })).toThrow(/at least one service line/);
    expect(() => build({ ...claim, lines: [{ ...claim.lines[0]!, units: 0 }] })).toThrow(/units/);
    expect(() => build({ ...claim, lines: [{ ...claim.lines[0]!, modifiers: ["2"] }] })).toThrow(/modifiers/);
    expect(() => build({ ...claim, lines: [{ ...claim.lines[0]!, diagnosisPointers: [9] }] })).toThrow(/no diagnosis/);
  });

  it("leaves the rendering loop out when the billing NPI renders", () => {
    const { doc } = build({ ...claim, rendering: null });
    expect(find(doc.segments, "NM1", "82")).toHaveLength(0);
  });
});
