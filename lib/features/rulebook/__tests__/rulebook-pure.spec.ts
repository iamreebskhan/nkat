import { describe, expect, it } from "vitest";

import { compareRulebooks, rowsAgree, summarizeComparison } from "../rulebook-pure";

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
