import { describe, expect, it } from "vitest";

import {
  compareRulebooks,
  confidenceDisplay,
  payerRuleSourceKind,
  rowsAgree,
  sourceKindFor,
  summarizeComparison,
  summarizeConfidence,
  type ConfidenceInput,
} from "../rulebook-pure";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("rowsAgree", () => {
  it("true when coverage + ruleValue match", () => {
    expect(
      rowsAgree(
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "covered", ruleValue: { answer: "yes" } },
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "covered", ruleValue: { answer: "yes" } },
      ),
    ).toBe(true);
  });

  it("false on coverage mismatch", () => {
    expect(
      rowsAgree(
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "covered", ruleValue: {} },
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "varies", ruleValue: {} },
      ),
    ).toBe(false);
  });

  it("false when ruleValue keys differ", () => {
    expect(
      rowsAgree(
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "covered", ruleValue: { a: 1 } },
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "covered", ruleValue: { a: 1, b: 2 } },
      ),
    ).toBe(false);
  });

  it("compares arrays semantically (order-independent)", () => {
    expect(
      rowsAgree(
        { payerId: A, state: "OH", cptCode: "99349", attribute: "modifier_required", coverageStatus: "covered", ruleValue: { modifiers: ["95", "GT"] } },
        { payerId: A, state: "OH", cptCode: "99349", attribute: "modifier_required", coverageStatus: "covered", ruleValue: { modifiers: ["GT", "95"] } },
      ),
    ).toBe(true);
  });
});

describe("compareRulebooks", () => {
  const orgRows = [
    { payerId: A, state: "OH", cptCode: "99349", attribute: "covered" as const, coverageStatus: "covered" as const, ruleValue: {} },
    { payerId: A, state: "OH", cptCode: "99350", attribute: "covered" as const, coverageStatus: "varies" as const, ruleValue: {} },
    { payerId: B, state: "NC", cptCode: "99349", attribute: "covered" as const, coverageStatus: "not_covered" as const, ruleValue: {} },
  ];

  const sourceRows = [
    { payerId: A, state: "OH", cptCode: "99349", attribute: "covered" as const, coverageStatus: "covered" as const, ruleValue: {}, sourceQuote: "Quoted." },
    { payerId: A, state: "OH", cptCode: "99350", attribute: "covered" as const, coverageStatus: "covered" as const, ruleValue: {} },
    { payerId: A, state: "OH", cptCode: "99347", attribute: "covered" as const, coverageStatus: "covered" as const, ruleValue: {} },
  ];

  it("emits 4 outcome buckets per §9.4.2", () => {
    const cmp = compareRulebooks({ orgRows, sourceRows });
    const byCpt = new Map(cmp.map((r) => [`${r.cptCode}-${r.payerId}-${r.state}`, r.outcome]));

    // 99349 OH org=covered + source=covered → match
    expect(byCpt.get("99349-" + A + "-OH")).toBe("match");
    // 99350 OH org=varies + source=covered → diff
    expect(byCpt.get("99350-" + A + "-OH")).toBe("diff");
    // 99349 NC org=not_covered + no source → unverified
    expect(byCpt.get("99349-" + B + "-NC")).toBe("unverified");
    // 99347 OH only in source → new_from_pallio
    expect(byCpt.get("99347-" + A + "-OH")).toBe("new_from_pallio");
  });

  it("sort order: diffs first, then unverified, then new, then matches", () => {
    const cmp = compareRulebooks({ orgRows, sourceRows });
    expect(cmp[0].outcome).toBe("diff");
    expect(cmp[cmp.length - 1].outcome).toBe("match");
  });

  it("preserves source citation on outcome rows", () => {
    const cmp = compareRulebooks({ orgRows, sourceRows });
    const matchRow = cmp.find((r) => r.outcome === "match");
    expect(matchRow?.sourceValue?.sourceQuote).toBe("Quoted.");
  });

  it("handles empty sets", () => {
    expect(compareRulebooks({ orgRows: [], sourceRows: [] })).toEqual([]);
  });
});

describe("summarizeComparison", () => {
  it("counts each bucket", () => {
    const cmp = compareRulebooks({
      orgRows: [
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "covered", ruleValue: {} },
        { payerId: A, state: "OH", cptCode: "99350", attribute: "covered", coverageStatus: "varies", ruleValue: {} },
      ],
      sourceRows: [
        { payerId: A, state: "OH", cptCode: "99349", attribute: "covered", coverageStatus: "covered", ruleValue: {} },
        { payerId: A, state: "OH", cptCode: "99350", attribute: "covered", coverageStatus: "covered", ruleValue: {} },
        { payerId: A, state: "OH", cptCode: "99347", attribute: "covered", coverageStatus: "covered", ruleValue: {} },
      ],
    });
    const s = summarizeComparison(cmp);
    expect(s.total).toBe(3);
    expect(s.matches).toBe(1);
    expect(s.diffs).toBe(1);
    expect(s.newFromPallio).toBe(1);
    expect(s.unverified).toBe(0);
  });
});

describe("provenance (audit R21)", () => {
  it("reads a document extraction as a published document", () => {
    expect(payerRuleSourceKind("extract:oh-appendix-dd")).toBe("crawler");
    expect(sourceKindFor("source", "extract:coverage-basis-2026-08")).toBe("crawler");
  });

  it("keeps the other markers", () => {
    expect(payerRuleSourceKind("crawler:cms_pfs")).toBe("crawler");
    expect(payerRuleSourceKind("crawler")).toBe("crawler");
    expect(payerRuleSourceKind("cms")).toBe("crawler");
    expect(payerRuleSourceKind("ai")).toBe("ai");
    expect(payerRuleSourceKind("analyst:u1")).toBe("analyst");
    expect(payerRuleSourceKind("a@b.test")).toBe("analyst");
    expect(payerRuleSourceKind("manual")).toBe("manual");
    expect(payerRuleSourceKind(null)).toBe("unknown");
    expect(payerRuleSourceKind("  ")).toBe("unknown");
  });

  it("lets the org's own provenance trump the linked rule's", () => {
    expect(sourceKindFor("org_upload", "extract:x")).toBe("org");
    expect(sourceKindFor("org_override", "crawler:cms")).toBe("org");
    expect(sourceKindFor("analyst", null)).toBe("analyst");
  });
});

const conf = (over: Partial<ConfidenceInput>): ConfidenceInput => ({
  origin: "source",
  confidence: 0.75,
  sourceKind: "crawler",
  sourcePayerRuleId: "r1",
  expiresAt: null,
  ...over,
});
const placeholder = conf({ confidence: 0, sourceKind: "unknown", sourcePayerRuleId: null });
const NOW = new Date("2026-09-15T12:00:00Z");

describe("confidenceDisplay (audit R21)", () => {
  it("says 'No rule on file' for a placeholder, never 0%", () => {
    expect(confidenceDisplay(placeholder, NOW)).toEqual({ label: "No rule on file", tone: "none" });
  });

  it("marks a machine-written row under the lookup floor as not used for billing", () => {
    expect(confidenceDisplay(conf({ confidence: 0.4, sourceKind: "ai" }), NOW).label).toBe(
      "AI draft · not used for billing",
    );
    expect(confidenceDisplay(conf({ confidence: 0.45 }), NOW).label).toBe("45% · not used for billing");
  });

  it("labels the org's own rows as the org's, whatever number they carry", () => {
    expect(confidenceDisplay(conf({ origin: "org_override", sourceKind: "org" }), NOW).label).toBe("Your org");
    expect(confidenceDisplay(conf({ origin: "org_upload", confidence: 0.5, sourceKind: "org" }), NOW).label).toBe(
      "Your org",
    );
  });

  it("says when an analyst attestation has expired", () => {
    const a = conf({ origin: "analyst", confidence: 0.6, sourceKind: "analyst", sourcePayerRuleId: null });
    expect(confidenceDisplay({ ...a, expiresAt: "2026-09-01T00:00:00Z" }, NOW)).toEqual({
      label: "Attestation expired",
      tone: "expired",
    });
    expect(confidenceDisplay({ ...a, expiresAt: "2026-10-08T00:00:00Z" }, NOW).label).toBe("60%");
  });

  it("prints a sourced rule as a percentage", () => {
    expect(confidenceDisplay(conf({}), NOW)).toEqual({ label: "75%", tone: "strong" });
  });
});

describe("summarizeConfidence (audit R21)", () => {
  it("says how many attributes have no rule: the case the old maximum hid", () => {
    const s = summarizeConfidence([conf({}), conf({}), placeholder], NOW);
    expect(s.label).toBe("75% · 1 of 3 not on file");
    expect(s.weakest).toBe(0);
  });

  it("headlines the weakest rule on file, not the strongest", () => {
    const s = summarizeConfidence(
      [conf({ confidence: 0.94 }), conf({ origin: "analyst", confidence: 0.6, sourceKind: "analyst" })],
      NOW,
    );
    expect(s.label).toBe("60%");
    expect(s.weakest).toBe(1);
  });

  it("puts an expired attestation below any score", () => {
    const s = summarizeConfidence(
      [
        conf({ confidence: 0.5 }),
        conf({ origin: "analyst", confidence: 0.6, sourceKind: "analyst", expiresAt: "2026-01-01T00:00:00Z" }),
      ],
      NOW,
    );
    expect(s.label).toBe("Attestation expired");
  });

  it("says 'No rule on file' when nothing is", () => {
    expect(summarizeConfidence([placeholder, placeholder], NOW)).toEqual({
      label: "No rule on file",
      tone: "none",
      weakest: null,
    });
    expect(summarizeConfidence([], NOW).label).toBe("No rule on file");
  });
});

describe("sourceKindFor — AI-synthesized rows the lookup caches", () => {
  it("badges an unlinked machine row that carries a confidence as an AI draft", () => {
    expect(sourceKindFor("source", null, { sourcePayerRuleId: null, confidence: 0.4 })).toBe("ai");
    expect(confidenceDisplay({ ...conf({ confidence: 0.4, sourcePayerRuleId: null }), sourceKind: "ai" }, NOW).label).toBe(
      "AI draft · not used for billing",
    );
  });

  it("keeps a generation placeholder (confidence 0) as no linked source", () => {
    expect(sourceKindFor("source", null, { sourcePayerRuleId: null, confidence: 0 })).toBe("unknown");
  });

  it("reads a linked row from its rule's marker", () => {
    expect(sourceKindFor("source", "extract:x", { sourcePayerRuleId: "r1", confidence: 0.85 })).toBe("crawler");
  });
});
