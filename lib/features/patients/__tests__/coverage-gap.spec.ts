/**
 * The intake note for a payer × coverage-state pair (audit R17).
 *
 * not_served must stay the R37 refusal, word for word, because the service
 * refuses the same pair. no_rules is the new, non-blocking note for a pair the
 * payer is listed for but Pallio holds no live rules in. Fixtures match the
 * local roster: Aetna serves OH/NC/SC with 125 live rules in OH, none in NC/SC.
 */
import { describe, expect, it } from "vitest";

import { coverageGap } from "../coverage-gap";
import { checkCoveragePair } from "../insurance-pure";

const CARESOURCE = { name: "CareSource Ohio", states: ["OH"], ruleStates: ["OH"] };
const AETNA = { name: "Aetna", states: ["OH", "NC", "SC"], ruleStates: ["OH"] };

describe("coverageGap", () => {
  it("says nothing when the payer serves the state and has rules there", () => {
    expect(coverageGap(CARESOURCE, "OH")).toBeNull();
    expect(coverageGap(AETNA, "oh")).toBeNull();
  });

  it("reports a state the payer is not listed for as not_served, in the server's own words", () => {
    const gap = coverageGap(AETNA, "UT");
    expect(gap?.kind).toBe("not_served");
    expect(gap?.message).toBe(checkCoveragePair({ name: "Aetna", statesServed: AETNA.states }, "UT"));
    expect(gap?.message).toBe("Aetna does not cover UT. It covers OH, NC, SC.");
  });

  it("reports a served state with no live rules as no_rules (Aetna · NC)", () => {
    const gap = coverageGap(AETNA, "NC");
    expect(gap?.kind).toBe("no_rules");
    expect(gap?.message).toContain("no published Aetna rules for NC");
  });

  it("does not guess at rules it was not told about", () => {
    expect(coverageGap({ name: "Aetna", states: ["OH", "NC", "SC"] }, "NC")).toBeNull();
  });

  it("treats a payer with no recorded states as unrestricted, as R37 does, leaving only the rules question", () => {
    expect(coverageGap({ name: "Any", states: [], ruleStates: [] }, "UT")?.kind).toBe("no_rules");
  });

  it("returns null without a payer or a state", () => {
    expect(coverageGap(undefined, "OH")).toBeNull();
    expect(coverageGap(AETNA, undefined)).toBeNull();
    expect(coverageGap(AETNA, null)).toBeNull();
    expect(coverageGap(AETNA, "  ")).toBeNull();
  });
});
