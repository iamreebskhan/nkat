import { describe, expect, it } from "vitest";

import { normalizeIcd10 } from "../icd10-format";

describe("normalizeIcd10", () => {
  it.each([
    ["I50.9", "I50.9"],
    ["i509", "I50.9"],
    [" i50.9 ", "I50.9"],
    ["Z634", "Z63.4"],
    ["R64", "R64"],
    ["c3490", "C34.90"],
    ["F03.90", "F03.90"],
    ["S72.001A", "S72.001A"],
    ["s72001a", "S72.001A"],
    // FY2027's genetic neurodevelopmental categories: a letter in second place.
    ["QA00101", "QA0.0101"],
    ["U07.1", "U07.1"],
  ])("%s → %s", (input, want) => {
    expect(normalizeIcd10(input)).toBe(want);
  });

  it.each([
    "",
    "I5",
    "heart failure",
    "50.9",
    "I50..9",
    "I5.09",
    "ABC",
    "I50.91234",
    "I50-9",
  ])("refuses %j", (input) => {
    expect(normalizeIcd10(input)).toBeNull();
  });
});
