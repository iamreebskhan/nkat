/**
 * The Claim ref a payer's 835 echoes back (audit R10).
 *
 * Nothing on a superbill could be matched by a remittance: the PDF printed a
 * 36-character UUID, and an 837 only guarantees 20 characters of the patient
 * control number come back in CLP01. The ref is 12 hex characters of the id,
 * and matching turns it into a primary-key range.
 */
import { describe, expect, it } from "vitest";

import { claimRefBounds, claimRefFor, normalizeClaimRef } from "../claim-ref";

const SB = "b2e303af-e2cb-4292-8d00-c35c07423a0d";

describe("claimRefFor", () => {
  it("is the first 12 hex characters of the bill's id, uppercased", () => {
    expect(claimRefFor(SB)).toBe("B2E303AFE2CB");
  });

  it("fits the 20 characters of CLP01 an 837 guarantees come back", () => {
    expect(claimRefFor(SB).length).toBeLessThanOrEqual(20);
  });
});

describe("claimRefBounds", () => {
  it("names the id range of every bill the ref could be", () => {
    expect(claimRefBounds("B2E303AFE2CB")).toEqual({
      lo: "b2e303af-e2cb-0000-0000-000000000000",
      hi: "b2e303af-e2cb-ffff-ffff-ffffffffffff",
    });
  });

  it("puts the bill's own id inside its ref's range", () => {
    const b = claimRefBounds(claimRefFor(SB))!;
    expect(SB >= b.lo && SB <= b.hi).toBe(true);
  });

  it("reads the ref the way a payer echoes it: re-cased, with spaces and dashes", () => {
    expect(normalizeClaimRef(" b2e3-03af e2cb ")).toBe("B2E303AFE2CB");
    expect(claimRefBounds(" b2e3-03af e2cb ")).toEqual(claimRefBounds("B2E303AFE2CB"));
  });

  it("accepts a whole id, which names itself", () => {
    expect(claimRefBounds(SB)).toEqual({ lo: SB, hi: SB });
    expect(claimRefBounds(SB.replace(/-/g, "").toUpperCase())).toEqual({ lo: SB, hi: SB });
  });

  it("CONTROL — gives null for anything that is not a ref, so matching falls back", () => {
    expect(claimRefBounds("CLAIM-001")).toBeNull();
    // Twelve characters, but not hex.
    expect(claimRefBounds("NOPE00000001")).toBeNull();
    expect(claimRefBounds("B2E303AFE2C")).toBeNull();
    expect(claimRefBounds("")).toBeNull();
  });
});
