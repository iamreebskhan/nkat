/**
 * A reply that ran out of room must not cost us the rules it did finish.
 *
 * Aetna's telemedicine payment policy filled the 16k output budget mid-array.
 * JSON.parse failed, the "first { to last }" fallback failed too — a
 * truncated array's last brace closes a half-written rule — and the document
 * was reported as
 *
 *   extractError=Expected ',' or ']' after array element in JSON at position 38375
 *
 * with zero rules. Every rule the model had already completed went with it.
 *
 * That is the all-or-nothing failure one level up from the one already fixed:
 * the schema check learned to judge rules individually, and then the PARSE
 * still judged them as a block.
 */
import { describe, expect, it } from "vitest";

import { recoverTruncatedRules } from "@/lib/ai/document-rule-extractor";

const rule = (code: string, quote = "Prior authorization is required.") =>
  `{"cptCode":"${code}","attribute":"covered","coverageStatus":"covered",` +
  `"answer":"Covered.","sourceQuote":${JSON.stringify(quote)}}`;

describe("recoverTruncatedRules", () => {
  it("keeps every rule that closed, and drops the half-written one", () => {
    const text =
      `{"rules":[${rule("99341")},${rule("99342")},` +
      `{"cptCode":"99343","attribute":"cove`; // cut off mid-object
    const got = recoverTruncatedRules(text) as { cptCode: string }[];
    expect(got.map((r) => r.cptCode)).toEqual(["99341", "99342"]);
  });

  it("survives braces and quotes inside a sourceQuote", () => {
    // Payer prose is full of both. Counting depth without tracking string
    // state would miscount here and lose good rules.
    const text =
      `{"rules":[${rule("99349", 'The plan states {see "Section 4"} applies.')},` +
      `${rule("99350", "Use modifier 95 {audio-video}.")},{"cptCode":"993`;
    const got = recoverTruncatedRules(text) as { cptCode: string }[];
    expect(got.map((r) => r.cptCode)).toEqual(["99349", "99350"]);
  });

  it("handles an escaped quote immediately before the close", () => {
    const text = `{"rules":[${rule("99213", 'He said \\"covered\\"')},{"cptCode":"99`;
    const got = recoverTruncatedRules(text) as { cptCode: string }[];
    expect(got).toHaveLength(1);
    expect(got[0].cptCode).toBe("99213");
  });

  it("returns everything from a reply that was NOT truncated", () => {
    const text = `{"rules":[${rule("99341")},${rule("99342")}]}`;
    expect(recoverTruncatedRules(text)).toHaveLength(2);
  });

  it("returns nothing when there is no rules array to walk", () => {
    expect(recoverTruncatedRules("")).toEqual([]);
    expect(recoverTruncatedRules("I could not read that document.")).toEqual([]);
    expect(recoverTruncatedRules('{"error":"nope"}')).toEqual([]);
  });

  it("returns nothing when the very first rule is incomplete", () => {
    // The caller turns this into "hit the output limit before a single
    // complete rule", which is a different message from "not JSON".
    expect(recoverTruncatedRules(`{"rules":[{"cptCode":"993`)).toEqual([]);
  });

  it("stops at the end of the rules array, ignoring what follows", () => {
    const text = `{"rules":[${rule("99341")}],"notes":{"a":1},"other":[{"b":2}]}`;
    const got = recoverTruncatedRules(text) as { cptCode: string }[];
    expect(got.map((r) => r.cptCode)).toEqual(["99341"]);
  });
});
