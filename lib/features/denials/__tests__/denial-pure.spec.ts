import { describe, expect, it } from "vitest";

import {
  computeDenialMetrics,
  describeDenialHeuristic,
  lookupCarc,
} from "../denial-pure";

describe("lookupCarc", () => {
  it("returns the curated entry for a known palliative CARC", () => {
    const e = lookupCarc("197");
    expect(e.text).toContain("authorization");
    expect(e.category).toBe("auth_required");
    expect(e.defaultRecommendation).toBe("appeal");
  });

  it("normalizes case", () => {
    const e = lookupCarc("b7");
    expect(e.code).toBe("B7");
    expect(e.category).toBe("billing_error");
  });

  it("returns 'Unknown' fallback for unmapped codes", () => {
    const e = lookupCarc("XYZZY");
    expect(e.category).toBe("other");
    expect(e.defaultRecommendation).toBe("unknown");
    expect(e.text).toContain("Unknown");
  });

  it("classifies timely-filing as write-off", () => {
    expect(lookupCarc("29").defaultRecommendation).toBe("write_off");
  });

  it("classifies medical-necessity as appeal", () => {
    expect(lookupCarc("50").defaultRecommendation).toBe("appeal");
  });

  it("classifies missing-info as refile", () => {
    expect(lookupCarc("16").defaultRecommendation).toBe("refile");
  });
});

describe("describeDenialHeuristic", () => {
  it("includes CPT + CARC in the heuristic string", () => {
    const r = describeDenialHeuristic({ carcCode: "197", cptCode: "99349" });
    expect(r.heuristic).toContain("99349");
    expect(r.heuristic).toContain("197");
    expect(r.recommendation).toBe("appeal");
  });
});

describe("computeDenialMetrics", () => {
  const sample = [
    { carcCode: "197", payerId: "p1", deniedAmountCents: 12000, decision: "pending" },
    { carcCode: "197", payerId: "p1", deniedAmountCents: 8000, decision: "refile" },
    { carcCode: "50", payerId: "p2", deniedAmountCents: 15000, decision: "pending" },
    { carcCode: "29", payerId: null, deniedAmountCents: 2500, decision: "write_off" },
  ];

  it("total counts + dollar amounts", () => {
    const m = computeDenialMetrics(sample);
    expect(m.total).toBe(4);
    expect(m.totalDeniedCents).toBe(37500);
    expect(m.pendingDecisions).toBe(2);
  });

  it("groups + sorts byCarc by dollar impact desc", () => {
    const m = computeDenialMetrics(sample);
    expect(m.byCarc[0].carc).toBe("197"); // 20000 cents > 15000 > 2500
    expect(m.byCarc[0].deniedCents).toBe(20000);
    expect(m.byCarc[0].count).toBe(2);
  });

  it("groups byPayerId, including nulls", () => {
    const m = computeDenialMetrics(sample);
    const nullBucket = m.byPayerId.find((b) => b.payerId === null);
    expect(nullBucket?.count).toBe(1);
    expect(nullBucket?.deniedCents).toBe(2500);
  });

  it("empty input returns zeros", () => {
    const m = computeDenialMetrics([]);
    expect(m.total).toBe(0);
    expect(m.totalDeniedCents).toBe(0);
    expect(m.byCarc).toEqual([]);
    expect(m.byPayerId).toEqual([]);
  });
});
