/**
 * The printed route sheet's day is the nurse's calendar day, not the UTC day.
 *
 * It took toISOString().slice(0, 10), so after 8 pm in Ohio the default was
 * tomorrow and an evening visit was filed under the next day. Dates here are
 * built from local components, so the assertions hold in any time zone.
 */
import { describe, expect, it } from "vitest";

import { localDateKey } from "../visit-pure";

describe("localDateKey", () => {
  it("is the calendar day where the viewer is, late in the evening and just after midnight", () => {
    expect(localDateKey(new Date(2026, 8, 9, 23, 30))).toBe("2026-09-09");
    expect(localDateKey(new Date(2026, 8, 9, 0, 5))).toBe("2026-09-09");
  });

  it("pads the month and the day", () => {
    expect(localDateKey(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });

  it("round-trips a stored timestamp to the day it falls on locally", () => {
    const evening = new Date(2026, 8, 9, 21, 0);
    expect(localDateKey(new Date(evening.toISOString()))).toBe("2026-09-09");
  });
});
