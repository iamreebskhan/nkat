/**
 * Clinician billing identity (audit R40 and R25): NPI check digit and the
 * credential → pricing-tier mapping.
 */
import { describe, expect, it } from "vitest";

import {
  CLINICIAN_CREDENTIALS,
  isValidNpi,
  providerIdentityWarnings,
  tierForCredential,
} from "../clinician";

describe("isValidNpi", () => {
  it("accepts the worked example CMS publishes (123456789 → check digit 3)", () => {
    expect(isValidNpi("1234567893")).toBe(true);
  });

  it("rejects a wrong check digit — a single mistyped digit", () => {
    expect(isValidNpi("1234567890")).toBe(false);
    expect(isValidNpi("1234567894")).toBe(false);
  });

  it("rejects two transposed digits", () => {
    // 1234567893 with 4 and 5 swapped.
    expect(isValidNpi("1235467893")).toBe(false);
  });

  it("rejects anything that is not exactly ten digits", () => {
    for (const bad of ["", "123456789", "12345678931", "12345 6789", "123456789X", "１２３４５６７８９３"]) {
      expect(isValidNpi(bad)).toBe(false);
    }
  });

  it("accepts other real-format NPIs whose check digit is right", () => {
    // Check digits computed independently with the same published rule.
    expect(isValidNpi("1497758544")).toBe(true);
    expect(isValidNpi("1003000126")).toBe(true);
  });
});

describe("tierForCredential", () => {
  it("prices physicians at the MD tier", () => {
    expect(tierForCredential("MD")).toBe("MD");
    expect(tierForCredential("DO")).toBe("MD");
  });

  it("prices NPs, PAs and CNSs at the NP/PA tier", () => {
    for (const c of ["NP", "PA", "CNS"]) expect(tierForCredential(c)).toBe("NP_PA");
  });

  it("returns null for credentials that do not bill home E/M", () => {
    for (const c of ["RN", "LCSW", "OTHER"]) expect(tierForCredential(c)).toBeNull();
  });

  it("returns null when the credential was never recorded", () => {
    expect(tierForCredential(null)).toBeNull();
    expect(tierForCredential(undefined)).toBeNull();
  });

  it("has a decision for every credential the schema allows", () => {
    for (const c of CLINICIAN_CREDENTIALS) {
      expect([null, "MD", "NP_PA"]).toContain(tierForCredential(c));
    }
  });
});

describe("providerIdentityWarnings", () => {
  it("is quiet for a clinician with their own valid NPI and a billing credential", () => {
    expect(
      providerIdentityWarnings({
        npi: "1234567893", fullName: "Jane NP", billingNpi: "1497758544", credential: "NP",
      }),
    ).toEqual([]);
  });

  it("infers the organization's stand-in when the rendering NPI equals the billing NPI", () => {
    const w = providerIdentityWarnings({
      npi: "1497758544", fullName: "Jane NP", billingNpi: "1497758544",
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/organization's NPI/);
  });

  it("names the clinician and the fix when there is no NPI", () => {
    const [w] = providerIdentityWarnings({ npi: "", fullName: "Jane NP" });
    expect(w).toMatch(/No NPI on file for Jane NP/);
    expect(w).toMatch(/Team page/);
  });

  it("says nothing about the credential when it was not looked up", () => {
    expect(providerIdentityWarnings({ npi: "1234567893", fullName: "Jane NP" })).toEqual([]);
  });

  it("uses a generic name when the clinician has none on file", () => {
    const [w] = providerIdentityWarnings({ npi: "", fullName: "  " });
    expect(w).toMatch(/the rendering clinician/);
  });
});
