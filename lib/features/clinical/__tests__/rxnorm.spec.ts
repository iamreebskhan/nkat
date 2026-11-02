/**
 * Finding a drug in RxNorm. fetch is a fake shaped from RxNav's real answers, so
 * nothing leaves the test. What matters: every concept RxNav matched comes back
 * by RxNorm's own name, only the words typed (and NLM's own RXCUIs) go out, and
 * an outage leaves free text working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { candidatesFrom, clinicalDrugsFrom, searchRxnorm } from "../rxnorm.service";

const NEAR = {
  approximateGroup: {
    candidate: [
      { rxcui: "29046", rxaui: "1", score: "7.8", rank: "1", name: "Lisinopril", source: "USP" },
      { rxcui: "29046", rxaui: "2", score: "7.8", rank: "1", source: "GS" },
      { rxcui: "29046", rxaui: "3", score: "7.8", rank: "1", name: "lisinopril", source: "RXNORM" },
      { rxcui: "29046", rxaui: "4", score: "7.8", rank: "1", name: "lisinopril", source: "RXNORM" },
      { rxcui: "206765", rxaui: "5", score: "6.0", rank: "2", name: "Lisinopril 10 mg", source: "MMSL" },
    ],
  },
};

// RxNav's answer to "lisinopril 10 mg tablet" (2 Nov 2026): one concept, matched
// only through VA's string. Keeping RxNorm's strings alone answered "No match".
const STRENGTH = {
  approximateGroup: {
    candidate: [
      { rxcui: "314076", rxaui: "a", score: "12.1", rank: "1", name: "LISINOPRIL 10MG TAB", source: "VANDF" },
      { rxcui: "314076", rxaui: "b", score: "12.1", rank: "1", name: "LISINOPRIL 10MG TAB", source: "VANDF" },
    ],
  },
};

const DRUGS = {
  drugGroup: {
    conceptGroup: [
      { tty: "BPCK" },
      { tty: "SBD", conceptProperties: [{ rxcui: "104377", name: "lisinopril 10 MG Oral Tablet [Zestril]" }] },
      { tty: "SCD", conceptProperties: [{ rxcui: "314076", name: "lisinopril 10 MG Oral Tablet" }, { rxcui: "29046", name: "lisinopril" }] },
    ],
  },
};

// /rxcui/{rxcui}/properties.json, as RxNav answers it; {} for a concept it has no name for.
let properties: Record<string, unknown>;

let urls: string[];
let answer: (url: string) => Promise<Response>;
const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  urls = [];
  properties = {
    "314076": { properties: { rxcui: "314076", name: "lisinopril 10 MG Oral Tablet", tty: "SCD" } },
    "206765": { properties: { rxcui: "206765", name: "lisinopril 10 MG Oral Tablet [Prinivil]", tty: "SBD" } },
  };
  answer = (url) => {
    const named = /\/rxcui\/(\d+)\/properties\.json$/.exec(url);
    if (named) return json(properties[named[1]!] ?? {});
    return json(url.includes("approximateTerm") ? NEAR : DRUGS);
  };
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    urls.push(url);
    return answer(url);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("what RxNav says", () => {
  it("keeps every concept it matched, once each, with RxNorm's own name where a match carries one", () => {
    expect(candidatesFrom(NEAR)).toEqual([
      { rxcui: "29046", name: "lisinopril" },
      { rxcui: "206765", name: null },
    ]);
    expect(candidatesFrom(STRENGTH)).toEqual([{ rxcui: "314076", name: null }]);
    expect(candidatesFrom({})).toEqual([]);
  });

  it("takes the clinical drugs, not the branded packs", () => {
    expect(clinicalDrugsFrom(DRUGS).map((c) => c.rxcui)).toEqual(["314076", "29046"]);
    expect(clinicalDrugsFrom({})).toEqual([]);
  });
});

describe("the search", () => {
  it("gives the matches first, by RxNorm's names, then the strengths, once each", async () => {
    const r = await searchRxnorm("lisinopril", "medication");
    expect(r).toEqual({
      rows: [
        { rxcui: "29046", name: "lisinopril" },
        { rxcui: "206765", name: "lisinopril 10 MG Oral Tablet [Prinivil]" },
        { rxcui: "314076", name: "lisinopril 10 MG Oral Tablet" },
      ],
      unavailable: false,
    });
  });

  it("finds a drug searched with its strength, by RxNorm's name for it", async () => {
    // A strength is not a drug name, so drugs.json has nothing for it.
    answer = (url) => {
      const named = /\/rxcui\/(\d+)\/properties\.json$/.exec(url);
      if (named) return json(properties[named[1]!] ?? {});
      return json(url.includes("approximateTerm") ? STRENGTH : {});
    };
    await expect(searchRxnorm("lisinopril 10 mg tablet", "medication")).resolves.toEqual({
      rows: [{ rxcui: "314076", name: "lisinopril 10 MG Oral Tablet" }],
      unavailable: false,
    });
  });

  it("CONTROL: leaves out a concept RxNav has no name for, and keeps the rest when a lookup fails", async () => {
    properties = {};
    const none = await searchRxnorm("lisinopril", "medication");
    expect(none.rows.map((c) => c.rxcui)).toEqual(["29046", "314076"]);
    answer = (url) => (url.includes("/properties.json") ? Promise.reject(new Error("timed out")) : json(url.includes("approximateTerm") ? NEAR : DRUGS));
    const failed = await searchRxnorm("lisinopril", "medication");
    expect(failed).toEqual({ rows: [{ rxcui: "29046", name: "lisinopril" }, { rxcui: "314076", name: "lisinopril 10 MG Oral Tablet" }], unavailable: false });
  });

  it("names at most five concepts a search, within RxNav's limit of 20 requests a second", async () => {
    const many = { approximateGroup: { candidate: Array.from({ length: 12 }, (_, i) => ({ rxcui: String(900 + i), name: `X${i}`, source: "VANDF" })) } };
    answer = (url) => (url.includes("/properties.json") ? json({ properties: { name: "named" } }) : json(url.includes("approximateTerm") ? many : {}));
    const r = await searchRxnorm("something 10 mg", "medication");
    expect(urls.filter((u) => u.includes("/properties.json"))).toHaveLength(5);
    expect(r.rows.map((c) => c.rxcui)).toEqual(["900", "901", "902", "903", "904"]);
  });

  it("asks for a substance, not tablets, for an allergy", async () => {
    await searchRxnorm("penicillin", "allergy");
    expect(urls.some((u) => u.includes("approximateTerm"))).toBe(true);
    expect(urls.some((u) => u.includes("drugs.json"))).toBe(false);
  });

  it("sends only the words typed, and NLM's own RXCUIs, to NLM", async () => {
    await searchRxnorm("  morphine sulfate ", "medication");
    expect(urls.some((u) => u.includes("/properties.json"))).toBe(true);
    for (const u of urls) {
      expect(u.startsWith("https://rxnav.nlm.nih.gov/REST/")).toBe(true);
      if (u.includes("/properties.json")) expect(u).toMatch(/\/rxcui\/206765\/properties\.json$/);
      else expect(u).toContain("morphine%20sulfate");
    }
  });

  it("keeps the match when the list of strengths is slow", async () => {
    answer = (url) =>
      url.includes("approximateTerm")
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(NEAR) } as Response)
        : Promise.reject(new Error("timed out"));
    await expect(searchRxnorm("metoprolol", "medication")).resolves.toEqual({ rows: [{ rxcui: "29046", name: "lisinopril" }], unavailable: false });
  });

  it("CONTROL: says it is unavailable when NLM is down, and never throws", async () => {
    answer = () => Promise.reject(new Error("offline"));
    await expect(searchRxnorm("lisinopril", "medication")).resolves.toEqual({ rows: [], unavailable: true });
    answer = () => Promise.resolve({ ok: false, status: 503 } as Response);
    await expect(searchRxnorm("lisinopril", "medication")).resolves.toEqual({ rows: [], unavailable: true });
  });
});
