/**
 * Which prolonged-service code a payer takes (0108): its record's own choice,
 * else the default for its type.
 */
import { describe, expect, it } from "vitest";

import { PAYER_TYPES } from "../payer-types";
import { defaultProlongedServiceCode, prolongedServiceCodeFor } from "../prolonged-code";

describe("defaultProlongedServiceCode", () => {
  it("is G0318 for Medicare and Medicare Advantage, and 99417 for every other type", () => {
    const byType = Object.fromEntries(PAYER_TYPES.map((t) => [t, defaultProlongedServiceCode(t)]));
    expect(byType).toEqual({
      medicare_mac: "G0318",
      medicare_advantage_org: "G0318",
      medicaid_state: "99417",
      medicaid_mco: "99417",
      commercial: "99417",
      tpa: "99417",
      workers_comp: "99417",
      auto_no_fault: "99417",
      tribal: "99417",
      self_insured: "99417",
      other: "99417",
    });
  });

  it("is 99417 with no payer at all, as the visit page has always assumed", () => {
    expect(defaultProlongedServiceCode(null)).toBe("99417");
  });
});

describe("prolongedServiceCodeFor", () => {
  it("takes the payer's own choice over its type, either way", () => {
    expect(prolongedServiceCodeFor("medicaid_mco", "G0318")).toBe("G0318");
    expect(prolongedServiceCodeFor("medicare_mac", "99417")).toBe("99417");
  });

  it("CONTROL: falls back to the type when the record names none", () => {
    expect(prolongedServiceCodeFor("medicaid_mco", null)).toBe("99417");
    expect(prolongedServiceCodeFor("medicare_advantage_org", undefined)).toBe("G0318");
  });
});
