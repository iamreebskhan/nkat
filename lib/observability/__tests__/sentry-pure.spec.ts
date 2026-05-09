import { describe, expect, it } from "vitest";

import { scrubPhi } from "../sentry";

describe("scrubPhi", () => {
  it("redacts SSN inside a string", () => {
    expect(scrubPhi("user 123-45-6789 hit /lookup")).toBe(
      "user [REDACTED-PHI] hit /lookup",
    );
  });

  it("redacts emails", () => {
    expect(scrubPhi({ msg: "send to alice@example.com please" })).toEqual({
      msg: "send to [REDACTED-PHI] please",
    });
  });

  it("walks nested objects", () => {
    const input = {
      level1: {
        level2: {
          payload: "MRN ABC123XY789 saw error",
        },
      },
    };
    const out = scrubPhi(input) as typeof input;
    expect(out.level1.level2.payload).toContain("[REDACTED-PHI]");
  });

  it("walks arrays", () => {
    const out = scrubPhi(["clean", "DOB: 03/14/1949"]);
    expect(out[0]).toBe("clean");
    expect(out[1]).toContain("[REDACTED-PHI]");
  });

  it("leaves clean strings alone", () => {
    expect(scrubPhi("Does Humana cover 99349 in OH?")).toBe(
      "Does Humana cover 99349 in OH?",
    );
  });

  it("doesn't choke on null + undefined + numbers", () => {
    expect(scrubPhi({ a: null, b: undefined, c: 42, d: true })).toEqual({
      a: null, b: undefined, c: 42, d: true,
    });
  });
});
