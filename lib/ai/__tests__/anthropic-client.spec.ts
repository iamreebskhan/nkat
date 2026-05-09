/**
 * Unit tests for the citation-parsing + PHI-detection logic in the
 * Anthropic client. These are deterministic — no API calls.
 *
 * The Claude integration is exercised via the gold-standard eval
 * (gold-standard.spec.ts, gated behind EVAL=1).
 */
import { describe, expect, it } from "vitest";

import { assertNoPhi } from "../anthropic.client";

describe("assertNoPhi", () => {
  it("passes a clean rule lookup query", () => {
    expect(() =>
      assertNoPhi("Does Humana Ohio cover 99349 telehealth?"),
    ).not.toThrow();
  });

  it("blocks SSN-looking strings", () => {
    expect(() => assertNoPhi("patient 123-45-6789 needs prior auth")).toThrow(
      /SSN/,
    );
  });

  it("blocks MRN prefixes", () => {
    expect(() => assertNoPhi("MRN: 102938475 — 99349 covered?")).toThrow(/MRN/);
  });

  it("blocks member-id prefixed strings", () => {
    expect(() =>
      assertNoPhi("member id: W12345678 humana telehealth?"),
    ).toThrow(/MemberID/);
  });

  it("blocks DOB-prefixed strings", () => {
    expect(() => assertNoPhi("DOB: 03/15/1962 — covered for 99350?")).toThrow(
      /DOB/,
    );
  });
});
