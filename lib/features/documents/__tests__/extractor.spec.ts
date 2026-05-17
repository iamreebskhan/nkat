import { describe, expect, it } from "vitest";

import { chunkText, parseCsv, parseRulebookCsv } from "../extractor";

describe("parseCsv", () => {
  it("handles quoted fields, embedded commas, escaped quotes, CRLF", () => {
    const csv = 'a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,z,';
    expect(parseCsv(csv)).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'he said "hi"'],
      ["2", "z", ""],
    ]);
  });
  it("drops fully-empty lines", () => {
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parseRulebookCsv", () => {
  it("parses a clean rulebook with header aliases + synonyms", () => {
    const csv = [
      "Payer,State,CPT Code,Rule Type,Covered?,Notes",
      "Aetna,OH,99349,covered,Yes,Established home visit",
      "Aetna,oh,99349,Prior Auth,No,No PA required",
      'Anthem,OH,99497,Telehealth,Varies,"Audio-video only, modifier 95"',
    ].join("\n");
    const { rows, errors } = parseRulebookCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      payerRef: "Aetna", state: "OH", cptCode: "99349",
      attribute: "covered", coverageStatus: "covered",
      ruleValue: { answer: "Established home visit" },
    });
    expect(rows[1].attribute).toBe("prior_auth");
    expect(rows[1].coverageStatus).toBe("not_covered");
    expect(rows[2].attribute).toBe("telehealth");
    expect(rows[2].coverageStatus).toBe("varies");
    expect(rows[2].ruleValue).toEqual({ answer: "Audio-video only, modifier 95" });
  });

  it("reports bad rows without aborting good ones", () => {
    const csv = [
      "payer,state,cpt,attribute,coverage,value",
      "Aetna,OHIO,99349,covered,yes,ok",       // bad state
      "Aetna,OH,99,covered,yes,ok",            // bad cpt
      "Aetna,OH,99349,teleportation,yes,ok",   // bad attribute
      "Aetna,OH,G0318,covered,yes,good row",   // valid
    ].join("\n");
    const { rows, errors } = parseRulebookCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].cptCode).toBe("G0318");
    expect(errors).toHaveLength(3);
  });

  it("errors when required columns are missing", () => {
    const { rows, errors } = parseRulebookCsv("foo,bar\n1,2");
    expect(rows).toEqual([]);
    expect(errors[0]).toMatch(/Missing required column/);
  });

  it("defaults coverage to unknown and value to {}", () => {
    const { rows } = parseRulebookCsv("state,cpt,attribute\nOH,99349,covered");
    expect(rows[0].coverageStatus).toBe("unknown");
    expect(rows[0].ruleValue).toEqual({});
    expect(rows[0].payerRef).toBeNull();
  });
});

describe("chunkText", () => {
  it("returns [] for empty input", () => {
    expect(chunkText("   \n\n ")).toEqual([]);
  });
  it("keeps small docs as one chunk", () => {
    expect(chunkText("para one\n\npara two")).toEqual(["para one\n\npara two"]);
  });
  it("splits on paragraphs when over the limit", () => {
    const a = "A".repeat(800);
    const b = "B".repeat(800);
    const chunks = chunkText(`${a}\n\n${b}`, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
  it("hard-wraps a single oversized paragraph", () => {
    const big = "x".repeat(5000);
    const chunks = chunkText(big, { maxChars: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });
});
