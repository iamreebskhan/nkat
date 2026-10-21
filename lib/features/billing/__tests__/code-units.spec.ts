/**
 * Units per code: the map that carries an add-on's count from the suggester to
 * the bill (visit.cpt_units, superbill.cpt_units, 0106).
 *
 * Before it existed the count lived only in the suggester's reason text, so
 * every add-on was saved, priced and printed as one unit. The map is keyed by
 * code and a code with no key is one unit, so every reader that treats the
 * codes as a set keeps working and every row written before 0106 ({}) still
 * means what was billed.
 *
 * Units above one belong only to the codes CPT/HCPCS define per time increment
 * (G0318, 99417, 99498). A home E/M is reported once per date of service, so a
 * 99350 × 2 is refused rather than quietly billed.
 */
import { describe, expect, it } from "vitest";

import {
  G0318_MAX_UNITS,
  PER_INCREMENT_CODES,
  formatCodes,
  normalizeUnits,
  sameAssignment,
  unitErrors,
  unitWarnings,
  unitsOf,
} from "../code-units";

describe("unitsOf", () => {
  it("defaults a code with no key to one unit", () => {
    expect(unitsOf({}, "99350")).toBe(1);
    expect(unitsOf(null, "G0318")).toBe(1);
    expect(unitsOf(undefined, "G0318")).toBe(1);
  });

  it("reads a whole number of units", () => {
    expect(unitsOf({ G0318: 3 }, "G0318")).toBe(3);
  });

  it("reads anything that is not a whole number from 1 to 99 as one unit", () => {
    for (const bad of [0, -1, 2.5, 100, Number.NaN]) {
      expect(unitsOf({ G0318: bad }, "G0318"), String(bad)).toBe(1);
    }
    expect(unitsOf({ G0318: "3" } as never, "G0318")).toBe(1);
  });
});

describe("normalizeUnits", () => {
  const codes = ["99350", "G0318", "99417", "99497", "99498"];

  it("keeps 2..99 on the per-increment codes", () => {
    expect(normalizeUnits(codes, { G0318: 2, "99417": 99, "99498": 3 })).toEqual({
      G0318: 2,
      "99417": 99,
      "99498": 3,
    });
  });

  it("drops a key for a code that is not on the claim — a stale key never lands on the wrong code", () => {
    expect(normalizeUnits(["99350"], { G0318: 3 })).toEqual({});
  });

  it("drops 1 (the canonical form omits it), 0, 2.5, a string and 100", () => {
    for (const bad of [1, 0, 2.5, "3", 100]) {
      expect(normalizeUnits(codes, { G0318: bad } as never), String(bad)).toEqual({});
    }
  });

  it("drops units on a code billed once per visit: the E/M base and 99497", () => {
    expect(normalizeUnits(codes, { "99350": 2, "99497": 2 })).toEqual({});
  });

  it("treats missing units as none", () => {
    expect(normalizeUnits(codes, undefined)).toEqual({});
    expect(normalizeUnits(codes, null)).toEqual({});
  });

  it("names exactly the three per-increment codes in this code set", () => {
    expect([...PER_INCREMENT_CODES].sort()).toEqual(["99417", "99498", "G0318"]);
  });
});

describe("unitErrors", () => {
  it("refuses units on a code billed once per visit", () => {
    const errors = unitErrors(["99350", "G0318"], { "99350": 2 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^99350 is billed once per visit; units apply only to G0318, 99417 and 99498\.$/);
  });

  it("passes units on a per-increment code", () => {
    expect(unitErrors(["99350", "G0318"], { G0318: 3 })).toEqual([]);
  });

  it("passes one unit on any code — one is what every code already is", () => {
    expect(unitErrors(["99350"], { "99350": 1 })).toEqual([]);
  });

  it("CONTROL: refuses a count that is not a whole number from 1 to 99, rather than leaving it to be dropped", () => {
    // normalizeUnits drops such a count, which bills one unit: a service
    // reached without the API's schema reset G0318 × 150 to × 1 and said
    // nothing. The schema refuses these first; this is the services' own guard.
    for (const bad of [150, 100, 0, -1, 2.5, Number.NaN, "3"]) {
      expect(unitErrors(["99350", "G0318"], { G0318: bad } as never), String(bad)).toEqual([
        "G0318 units must be a whole number from 1 to 99.",
      ]);
    }
    expect(unitErrors(["99350", "G0318"], { G0318: 99 })).toEqual([]);
  });
});

describe("unitWarnings", () => {
  it("warns above Pallio's G0318 cap, without calling it a Medicare rule", () => {
    const w = unitWarnings(["99350", "G0318"], { G0318: G0318_MAX_UNITS + 1 });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("G0318 is billed at 5 units");
    expect(w[0]).toContain("Pallio allows");
    expect(w[0]).not.toMatch(/Medicare allows/);
  });

  it("is quiet at the cap", () => {
    expect(unitWarnings(["99350", "G0318"], { G0318: 4 })).toEqual([]);
  });

  it("is quiet when G0318 is not on the claim, whatever a stale key says", () => {
    expect(unitWarnings(["99350"], { G0318: 9 })).toEqual([]);
  });
});

describe("formatCodes", () => {
  it("prints units beside the code that carries them", () => {
    expect(formatCodes(["99350", "G0318"], { G0318: 3 })).toBe("99350, G0318 ×3");
  });

  it("prints a one-unit claim as the plain list it always was", () => {
    expect(formatCodes(["99350", "G0318"], {})).toBe("99350, G0318");
    expect(formatCodes([], {})).toBe("");
  });
});

describe("sameAssignment", () => {
  it("ignores order and duplicates", () => {
    expect(sameAssignment(["G0318", "99350", "99350"], {}, ["99350", "G0318"], {})).toBe(true);
  });

  it("treats {} as one unit per code", () => {
    expect(sameAssignment(["99350", "G0318"], {}, ["99350", "G0318"], { G0318: 1 })).toBe(true);
  });

  it("differs on units alone", () => {
    expect(sameAssignment(["99350", "G0318"], { G0318: 3 }, ["99350", "G0318"], { G0318: 2 })).toBe(false);
    expect(sameAssignment(["99350", "G0318"], { G0318: 3 }, ["99350", "G0318"], {})).toBe(false);
  });

  it("differs on codes", () => {
    expect(sameAssignment(["99350"], {}, ["99350", "G0318"], {})).toBe(false);
  });
});
