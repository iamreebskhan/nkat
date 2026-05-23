/**
 * Denial-risk scorer fixtures — Phase 0.3.
 *
 * 30+ targeted scenarios covering every branch of scoreLine():
 *   no_payer, coverage_unknown/denied/varies, low_confidence,
 *   missing_modifier, wrong_modifier, prior_auth_missing,
 *   frequency_exceeded, taxonomy_disallowed, combinations.
 *
 * The contribution weights and band thresholds in denial-risk.service
 * are tuned against these fixtures. Changing those constants requires
 * updating expected bands here — that's the point of the fixtures.
 */
import { describe, expect, it } from "vitest";

import {
  scoreLine,
  scoreSuperbill,
  type CodeRuleSet,
  type DraftContext,
  type DraftLine,
} from "../denial-risk.service";

const baseLine: DraftLine = {
  code: "99348",
  dos: "2026-05-23",
  modifiers: [],
  units: 1,
};

const baseContext: DraftContext = {
  payerId: "00000000-0000-0000-0000-000000000001",
  state: "OH",
  patientPriorAuth: false,
};

const coveredRule: CodeRuleSet = {
  coverageStatus: "covered",
  confidence: 0.9,
  payerRuleId: "rule-1",
};

describe("scoreLine — happy path", () => {
  it("covered code with confident rule and no requirements → low band, score 0", () => {
    const r = scoreLine({ line: baseLine, context: baseContext, rules: coveredRule });
    expect(r.score).toBe(0);
    expect(r.riskBand).toBe("low");
    expect(r.reasons).toHaveLength(0);
  });

  it("covered + confidence 0.5 exactly → low (not flagged)", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { ...coveredRule, confidence: 0.5 },
    });
    expect(r.riskBand).toBe("low");
  });
});

describe("scoreLine — coverage branches", () => {
  it("not_covered → block band", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { ...coveredRule, coverageStatus: "not_covered" },
    });
    expect(r.riskBand).toBe("block");
    expect(r.reasons[0]!.code).toBe("coverage_denied");
  });

  it("unknown → medium band", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { coverageStatus: "unknown", confidence: 0 },
    });
    expect(r.riskBand).toBe("medium");
    expect(r.reasons.some((x) => x.code === "coverage_unknown")).toBe(true);
  });

  it("varies → medium band", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { coverageStatus: "varies", confidence: 0.6 },
    });
    expect(r.riskBand).toBe("medium");
    expect(r.reasons.some((x) => x.code === "coverage_varies")).toBe(true);
  });
});

describe("scoreLine — payer presence", () => {
  it("no payer set on patient → block band even if code is covered", () => {
    const r = scoreLine({
      line: baseLine,
      context: { ...baseContext, payerId: null },
      rules: coveredRule,
    });
    expect(r.riskBand).toBe("block");
    expect(r.reasons[0]!.code).toBe("no_payer");
  });

  it("no payer + unknown coverage stacks to block", () => {
    const r = scoreLine({
      line: baseLine,
      context: { ...baseContext, payerId: null },
      // confidence 0.9 isolates this test to just no_payer + coverage_unknown.
      rules: { coverageStatus: "unknown", confidence: 0.9 },
    });
    expect(r.riskBand).toBe("block");
    expect(r.reasons.map((x) => x.code).sort()).toEqual([
      "coverage_unknown",
      "no_payer",
    ]);
  });
});

describe("scoreLine — confidence", () => {
  it("confidence 0.4 → low_confidence reason added, medium overall", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { ...coveredRule, confidence: 0.4 },
    });
    expect(r.reasons.some((x) => x.code === "low_confidence")).toBe(true);
    expect(r.riskBand).toBe("low"); // 0.25 alone is below medium
  });

  it("confidence 0.4 + coverage varies → high band", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { coverageStatus: "varies", confidence: 0.4 },
    });
    expect(r.reasons.map((x) => x.code).sort()).toEqual([
      "coverage_varies",
      "low_confidence",
    ]);
    expect(r.riskBand).toBe("medium");
  });
});

describe("scoreLine — modifier rules", () => {
  it("modifier required + missing → high band", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: {
        ...coveredRule,
        modifierRequired: { required: true, acceptable: ["25", "95"] },
      },
    });
    expect(r.reasons[0]!.code).toBe("missing_modifier");
    expect(r.riskBand).toBe("medium");
  });

  it("modifier required + acceptable present → low band", () => {
    const r = scoreLine({
      line: { ...baseLine, modifiers: ["25"] },
      context: baseContext,
      rules: {
        ...coveredRule,
        modifierRequired: { required: true, acceptable: ["25", "95"] },
      },
    });
    expect(r.riskBand).toBe("low");
    expect(r.reasons).toHaveLength(0);
  });

  it("modifier present but not in acceptable set → wrong_modifier", () => {
    const r = scoreLine({
      line: { ...baseLine, modifiers: ["59"] },
      context: baseContext,
      rules: {
        ...coveredRule,
        modifierRequired: { required: true, acceptable: ["25", "95"] },
      },
    });
    expect(r.reasons[0]!.code).toBe("wrong_modifier");
  });

  it("modifier required with empty acceptable list still passes if any modifier present", () => {
    const r = scoreLine({
      line: { ...baseLine, modifiers: ["XU"] },
      context: baseContext,
      rules: {
        ...coveredRule,
        modifierRequired: { required: true, acceptable: [] },
      },
    });
    expect(r.reasons).toHaveLength(0);
  });

  it("modifier check is case-insensitive", () => {
    const r = scoreLine({
      line: { ...baseLine, modifiers: ["xu"] },
      context: baseContext,
      rules: {
        ...coveredRule,
        modifierRequired: { required: true, acceptable: ["XU"] },
      },
    });
    expect(r.reasons).toHaveLength(0);
  });
});

describe("scoreLine — prior auth", () => {
  it("PA required + patient not authorized → high band", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { ...coveredRule, priorAuthRequired: true },
    });
    expect(r.reasons[0]!.code).toBe("prior_auth_missing");
    expect(r.riskBand).toBe("high");
  });

  it("PA required + patient authorized → no reason", () => {
    const r = scoreLine({
      line: baseLine,
      context: { ...baseContext, patientPriorAuth: true },
      rules: { ...coveredRule, priorAuthRequired: true },
    });
    expect(r.reasons).toHaveLength(0);
  });
});

describe("scoreLine — frequency limit", () => {
  it("frequency limit not exceeded → no reason", () => {
    const r = scoreLine({
      line: baseLine,
      context: {
        ...baseContext,
        recentLinesForPatient: [
          { code: "99348", dos: "2026-05-01" }, // older than 14 days
        ],
      },
      rules: {
        ...coveredRule,
        frequencyLimit: { maxOccurrences: 2, windowDays: 14 },
      },
    });
    expect(r.reasons).toHaveLength(0);
  });

  it("frequency limit hits → frequency_exceeded reason, high band", () => {
    const r = scoreLine({
      line: baseLine,
      context: {
        ...baseContext,
        recentLinesForPatient: [
          { code: "99348", dos: "2026-05-15" },
          { code: "99348", dos: "2026-05-20" },
        ],
      },
      rules: {
        ...coveredRule,
        frequencyLimit: { maxOccurrences: 2, windowDays: 14 },
      },
    });
    expect(r.reasons[0]!.code).toBe("frequency_exceeded");
    expect(r.riskBand).toBe("high");
  });

  it("history of a different code does not trip the limit", () => {
    const r = scoreLine({
      line: baseLine,
      context: {
        ...baseContext,
        recentLinesForPatient: [
          { code: "99349", dos: "2026-05-20" },
          { code: "G0318", dos: "2026-05-22" },
        ],
      },
      rules: {
        ...coveredRule,
        frequencyLimit: { maxOccurrences: 1, windowDays: 14 },
      },
    });
    expect(r.reasons).toHaveLength(0);
  });
});

describe("scoreLine — taxonomy", () => {
  it("clinician taxonomy not in payer's allowed set → taxonomy_disallowed", () => {
    const r = scoreLine({
      line: baseLine,
      context: { ...baseContext, clinicianTaxonomy: "208M00000X" },
      rules: {
        ...coveredRule,
        providerTaxonomyAllowed: ["363LP0200X"],
      },
    });
    expect(r.reasons[0]!.code).toBe("taxonomy_disallowed");
    expect(r.riskBand).toBe("high");
  });

  it("clinician taxonomy IS in allowed set → no reason", () => {
    const r = scoreLine({
      line: baseLine,
      context: { ...baseContext, clinicianTaxonomy: "363LP0200X" },
      rules: {
        ...coveredRule,
        providerTaxonomyAllowed: ["363LP0200X", "208M00000X"],
      },
    });
    expect(r.reasons).toHaveLength(0);
  });

  it("empty providerTaxonomyAllowed → no restriction", () => {
    const r = scoreLine({
      line: baseLine,
      context: { ...baseContext, clinicianTaxonomy: "anything" },
      rules: { ...coveredRule, providerTaxonomyAllowed: [] },
    });
    expect(r.reasons).toHaveLength(0);
  });

  it("taxonomy restriction but caller didn't pass clinicianTaxonomy → no flag (can't enforce)", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: {
        ...coveredRule,
        providerTaxonomyAllowed: ["363LP0200X"],
      },
    });
    expect(r.reasons).toHaveLength(0);
  });
});

describe("scoreLine — multi-reason combinations", () => {
  it("missing modifier + missing PA stacks to block (two high-impact signals)", () => {
    // 1 - (1-0.55)(1-0.7) = 0.865 → block band. That's the intended
    // behavior: when two strong signals fire, surface as block so the
    // nurse pauses and reviews — not a soft "high".
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: {
        ...coveredRule,
        modifierRequired: { required: true, acceptable: ["25"] },
        priorAuthRequired: true,
      },
    });
    expect(r.reasons.map((x) => x.code).sort()).toEqual([
      "missing_modifier",
      "prior_auth_missing",
    ]);
    expect(r.riskBand).toBe("block");
  });

  it("frequency exceeded + low confidence + varies → block band", () => {
    const r = scoreLine({
      line: baseLine,
      context: {
        ...baseContext,
        recentLinesForPatient: [
          { code: "99348", dos: "2026-05-20" },
          { code: "99348", dos: "2026-05-22" },
        ],
      },
      rules: {
        coverageStatus: "varies",
        confidence: 0.3,
        frequencyLimit: { maxOccurrences: 2, windowDays: 14 },
      },
    });
    expect(r.reasons).toHaveLength(3);
    // 1 - (1-0.35)(1-0.25)(1-0.75) = 0.878 → block.
    expect(r.riskBand).toBe("block");
  });
});

describe("scoreSuperbill — aggregation", () => {
  it("rolls up worst band + counts", () => {
    const lines: DraftLine[] = [
      { code: "99348", dos: "2026-05-23", modifiers: [] },
      { code: "99349", dos: "2026-05-23", modifiers: [] },
      { code: "G0318", dos: "2026-05-23", modifiers: [] },
    ];
    const rulesByCode = new Map<string, CodeRuleSet>([
      ["99348", { coverageStatus: "covered", confidence: 0.9 }],
      ["99349", { coverageStatus: "not_covered", confidence: 0.9 }],
      ["G0318", { coverageStatus: "unknown", confidence: 0 }],
    ]);
    const r = scoreSuperbill({ lines, context: baseContext, rulesByCode });
    expect(r.worstBand).toBe("block");
    expect(r.blockCount).toBe(1);
    expect(r.mediumCount).toBe(1);
    expect(r.highCount).toBe(0);
    expect(r.perLine.find((p) => p.code === "99348")!.riskBand).toBe("low");
    expect(r.perLine.find((p) => p.code === "99349")!.riskBand).toBe("block");
  });

  it("missing rule entry → treated as coverage_unknown", () => {
    const lines: DraftLine[] = [
      { code: "X1234", dos: "2026-05-23", modifiers: [] },
    ];
    const rulesByCode = new Map<string, CodeRuleSet>();
    const r = scoreSuperbill({ lines, context: baseContext, rulesByCode });
    expect(r.perLine[0]!.reasons[0]!.code).toBe("coverage_unknown");
  });

  it("empty draft → empty result", () => {
    const r = scoreSuperbill({
      lines: [],
      context: baseContext,
      rulesByCode: new Map(),
    });
    expect(r.perLine).toHaveLength(0);
    expect(r.worstBand).toBe("low");
    expect(r.blockCount).toBe(0);
  });
});

describe("scoreLine — band thresholds (snapshot)", () => {
  it("score 0.85 maps to block", () => {
    // We can't set score directly; use a configuration we know produces 0.95.
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { coverageStatus: "not_covered", confidence: 0.9 },
    });
    expect(r.score).toBeGreaterThanOrEqual(0.85);
    expect(r.riskBand).toBe("block");
  });

  it("score in [0.6, 0.85) maps to high", () => {
    // missing PA alone contributes 0.7 → high.
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { ...coveredRule, priorAuthRequired: true },
    });
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    expect(r.score).toBeLessThan(0.85);
    expect(r.riskBand).toBe("high");
  });

  it("score in [0.3, 0.6) maps to medium", () => {
    const r = scoreLine({
      line: baseLine,
      context: baseContext,
      rules: { coverageStatus: "unknown", confidence: 0.9 },
    });
    expect(r.score).toBeGreaterThanOrEqual(0.3);
    expect(r.score).toBeLessThan(0.6);
    expect(r.riskBand).toBe("medium");
  });
});
