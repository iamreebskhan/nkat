/**
 * Place of service on the visit (audit R23).
 */
import { describe, expect, it } from "vitest";

import {
  VISIT_POS_OPTIONS,
  defaultPosFor,
  posLabel,
  posTelehealthConflict,
} from "../place-of-service";

describe("place of service", () => {
  it("prefills 10 for telehealth and 12 (home) otherwise", () => {
    expect(defaultPosFor(true)).toBe("10");
    expect(defaultPosFor(false)).toBe("12");
  });

  it("labels a code for the screen, and says when none was recorded", () => {
    expect(posLabel("13")).toBe("13 · Assisted living facility");
    expect(posLabel("31")).toBe("31 · Skilled nursing facility");
    expect(posLabel("45")).toBe("45");
    expect(posLabel(null)).toBe("not recorded");
  });

  it("flags a telehealth code on an in-person visit", () => {
    expect(posTelehealthConflict("10", false)).toMatch(/telehealth code/);
    expect(posTelehealthConflict("02", false)).toMatch(/telehealth code/);
  });

  it("does not flag a telehealth code on a telehealth visit, or an in-person code", () => {
    expect(posTelehealthConflict("10", true)).toBeNull();
    expect(posTelehealthConflict("12", false)).toBeNull();
    expect(posTelehealthConflict(null, false)).toBeNull();
  });

  it("offers only two-digit codes, each once", () => {
    const codes = VISIT_POS_OPTIONS.map((o) => o.code);
    for (const c of codes) expect(c).toMatch(/^\d{2}$/);
    expect(new Set(codes).size).toBe(codes.length);
    // The two defaults must be pickable.
    expect(codes).toContain("12");
    expect(codes).toContain("10");
  });
});
