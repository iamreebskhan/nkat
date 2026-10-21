/**
 * Payer × coverage-state validation (audit R37).
 */
import { describe, expect, it } from "vitest";

import { checkCoveragePair } from "../insurance-pure";

const CARESOURCE = { name: "CareSource Ohio", statesServed: ["OH"] };
const AETNA = { name: "Aetna", statesServed: ["OH", "NC", "SC"] };

describe("checkCoveragePair", () => {
  it("accepts a state the payer covers", () => {
    expect(checkCoveragePair(CARESOURCE, "OH")).toBeNull();
    expect(checkCoveragePair(AETNA, "NC")).toBeNull();
  });

  it("refuses a state the payer does not cover, and names the ones it does", () => {
    expect(checkCoveragePair(CARESOURCE, "UT")).toBe(
      "CareSource Ohio does not cover UT. It covers OH.",
    );
    expect(checkCoveragePair(AETNA, "TX")).toBe("Aetna does not cover TX. It covers OH, NC, SC.");
  });

  it("compares case-insensitively — the form uppercases, an API client may not", () => {
    expect(checkCoveragePair(CARESOURCE, "oh")).toBeNull();
  });

  it("asks for a state when there is none", () => {
    expect(checkCoveragePair(CARESOURCE, null)).toBe("Set the coverage state for CareSource Ohio.");
    expect(checkCoveragePair(CARESOURCE, "  ")).toBe("Set the coverage state for CareSource Ohio.");
  });

  it("treats a payer with no recorded states as unrestricted", () => {
    expect(checkCoveragePair({ name: "Any", statesServed: [] }, "UT")).toBeNull();
  });
});
