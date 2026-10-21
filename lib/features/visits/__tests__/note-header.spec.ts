/**
 * The care-team block of the note header (audit R30), as page 1 of Mark's
 * note lays it out: palliative care provider, primary care provider,
 * referring physician, then the specialists by their own labels. Pure.
 */
import { describe, expect, it } from "vitest";

import { careTeamHeaderRows, type HeaderContact, type HeaderProvider } from "../note-render";

const P = (role: string, full_name: string, extra: Partial<HeaderProvider> = {}): HeaderProvider => ({
  role, role_label: null, full_name, npi: null, phone: null, ...extra,
});
const C = (full_name: string, extra: Partial<HeaderContact> = {}): HeaderContact => ({
  full_name, phone: null, is_healthcare_poa: false, is_primary_caregiver: false, ...extra,
});

describe("careTeamHeaderRows", () => {
  it("prints the rows in a fixed order, whatever order they arrive in", () => {
    const rows = careTeamHeaderRows({
      palliativeProvider: "Test Admin",
      providers: [
        P("other", "Hospice liaison"),
        P("specialist", "Dr Sam Ortiz", { role_label: "Oncologist" }),
        P("referring", "Dr Rae Kim"),
        P("specialist", "Dr Priya Nair", { role_label: "Pulmonologist" }),
        P("primary_care", "Dr Alan Brooks", { npi: "1234567893" }),
      ],
      contacts: [
        C("Mary Singleton", { phone: "614-555-0142", is_primary_caregiver: true }),
        C("Tom Reyes", { is_healthcare_poa: true }),
      ],
    });
    expect(rows.map((r) => r.label)).toEqual([
      "Palliative care provider",
      "Primary care provider",
      "Referring physician",
      "Oncologist",
      "Pulmonologist",
      "Other provider",
      "Healthcare POA",
      "Primary caregiver",
    ]);
  });

  it("always prints primary care and referring, as — when none is on file", () => {
    const rows = careTeamHeaderRows({ palliativeProvider: null, providers: [], contacts: [] });
    expect(rows).toEqual([
      { label: "Palliative care provider", value: "—" },
      { label: "Primary care provider", value: "—" },
      { label: "Referring physician", value: "—" },
    ]);
  });

  it("labels each specialist with its role label", () => {
    const rows = careTeamHeaderRows({
      palliativeProvider: null,
      providers: [P("specialist", "Dr Priya Nair", { role_label: "Pulmonologist" })],
      contacts: [],
    });
    expect(rows).toContainEqual({ label: "Pulmonologist", value: "Dr Priya Nair" });
  });

  it("names the POA and primary caregiver only when someone holds the role", () => {
    const none = careTeamHeaderRows({ palliativeProvider: null, providers: [], contacts: [C("Kim Test")] });
    expect(none.map((r) => r.label)).not.toContain("Healthcare POA");
    expect(none.map((r) => r.label)).not.toContain("Primary caregiver");
    const both = careTeamHeaderRows({
      palliativeProvider: null,
      providers: [],
      contacts: [C("Tom Reyes", { is_healthcare_poa: true, is_primary_caregiver: true })],
    });
    expect(both.slice(-2)).toEqual([
      { label: "Healthcare POA", value: "Tom Reyes" },
      { label: "Primary caregiver", value: "Tom Reyes" },
    ]);
  });

  it("formats the NPI and phone as 'Name (NPI n) · phone'", () => {
    const [, pcp] = careTeamHeaderRows({
      palliativeProvider: null,
      providers: [P("primary_care", "Dr Alan Brooks", { npi: "1234567893", phone: "614-555-0100" })],
      contacts: [],
    });
    expect(pcp).toEqual({ label: "Primary care provider", value: "Dr Alan Brooks (NPI 1234567893) · 614-555-0100" });
    const [caregiver] = careTeamHeaderRows({
      palliativeProvider: null,
      providers: [],
      contacts: [C("Mary Singleton", { phone: "614-555-0142", is_primary_caregiver: true })],
    }).slice(-1);
    expect(caregiver).toEqual({ label: "Primary caregiver", value: "Mary Singleton · 614-555-0142" });
  });

  it("returns plain text — escaping is the caller's job", () => {
    const [, pcp] = careTeamHeaderRows({
      palliativeProvider: null,
      providers: [P("primary_care", "Dr <b>Brooks</b>")],
      contacts: [],
    });
    expect(pcp!.value).toBe("Dr <b>Brooks</b>");
  });
});
