/**
 * The Time spent panel's code suggestion.
 *
 * It suggested each home-visit code ten minutes before its time threshold
 * (25 minutes → 99348, which needs 30), and "Use this code" added it in one
 * click. The thresholds are the codes' minimum total times: 99347 20,
 * 99348 30, 99349 40, 99350 60.
 */
import { describe, expect, it } from "vitest";

import { HOME_VISIT_ESTABLISHED, suggestedHomeVisitCode } from "../time-spent-panel";

const code = (m: number) => suggestedHomeVisitCode(m)?.code ?? null;

describe("suggestedHomeVisitCode", () => {
  it("never suggests a code below its minimum time", () => {
    expect(code(25)).toBe("99347");
    expect(code(29)).toBe("99347");
    expect(code(30)).toBe("99348");
    expect(code(39)).toBe("99348");
    expect(code(40)).toBe("99349");
    expect(code(59)).toBe("99349");
    expect(code(60)).toBe("99350");
    expect(code(95)).toBe("99350");
  });

  it("suggests nothing under 20 minutes", () => {
    expect(code(0)).toBeNull();
    expect(code(10)).toBeNull();
    expect(code(19)).toBeNull();
    expect(code(20)).toBe("99347");
  });

  it("matches the code table's typical minutes", () => {
    expect(HOME_VISIT_ESTABLISHED.map((b) => [b.code, b.min])).toEqual([
      ["99347", 20],
      ["99348", 30],
      ["99349", 40],
      ["99350", 60],
    ]);
  });

  it("carries no CPT descriptor text (AMA-licensed, audit R21)", () => {
    for (const b of HOME_VISIT_ESTABLISHED) expect(Object.keys(b).sort()).toEqual(["code", "max", "min"]);
  });

  it("codes on the ladder it is given, and on nothing when that ladder is empty", () => {
    const newPatient = [
      { min: 15, max: 29, code: "99341" },
      { min: 30, max: 59, code: "99342" },
    ];
    expect(suggestedHomeVisitCode(25, newPatient)?.code).toBe("99341");
    expect(suggestedHomeVisitCode(14, newPatient)).toBeNull();
    expect(suggestedHomeVisitCode(45, [])).toBeNull();
  });
});
