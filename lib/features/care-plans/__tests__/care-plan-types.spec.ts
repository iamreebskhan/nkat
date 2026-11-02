/**
 * The formal care plan's structured parts (0116): the escalation check that
 * decides when the NP hears of a reading, and when monitoring falls due. Pure.
 */
import { describe, expect, it } from "vitest";

import {
  CarePlanStructureSchema,
  EscalationRuleSchema,
  crossedRules,
  escalationRuleText,
  eventRuleFor,
  monitoringDue,
} from "../care-plan.types";

describe("escalation parameters", () => {
  const rules = [
    { measure: "pain", threshold: 7 },
    { measure: "spo2", threshold: 90 },
    { measure: "fall", threshold: null },
  ];

  it("a symptom at or above its limit crosses; oxygen at or below its limit crosses", () => {
    expect(crossedRules(rules, { pain: 7, spo2: 90 })).toEqual([
      { measure: "pain", value: 7, threshold: 7 },
      { measure: "spo2", value: 90, threshold: 90 },
    ]);
  });

  it("CONTROL: under the limits nothing crosses, and a reading not taken is no reading", () => {
    expect(crossedRules(rules, { pain: 6, spo2: 91 })).toEqual([]);
    expect(crossedRules(rules, { pain: null, spo2: undefined })).toEqual([]);
    // A measure with no rule never crosses, however high.
    expect(crossedRules(rules, { nausea: 10 })).toEqual([]);
  });

  it("CONTROL: a stored rule that does not parse is skipped, not allowed to break the save", () => {
    expect(crossedRules([{ measure: "pain", threshold: "7" }, { measure: "mood", threshold: 1 }, null], { pain: 9 })).toEqual([]);
    expect(crossedRules("not a list", { pain: 9 })).toEqual([]);
  });

  it("an event rule is asked for by kind; a symptom rule is not an event rule", () => {
    expect(eventRuleFor(rules, "fall")).toBe("fall");
    expect(eventRuleFor(rules, "ed_visit")).toBeNull();
    expect(eventRuleFor([{ measure: "pain", threshold: 7 }], "pain")).toBeNull();
  });

  it("CONTROL: the schema refuses a limit out of range, a fraction, and a limit on an event", () => {
    expect(EscalationRuleSchema.safeParse({ measure: "pain", threshold: 11 }).success).toBe(false);
    expect(EscalationRuleSchema.safeParse({ measure: "pain", threshold: 6.5 }).success).toBe(false);
    expect(EscalationRuleSchema.safeParse({ measure: "pain", threshold: null }).success).toBe(false);
    expect(EscalationRuleSchema.safeParse({ measure: "fall", threshold: 1 }).success).toBe(false);
    expect(EscalationRuleSchema.safeParse({ measure: "pps", threshold: 30 }).success).toBe(true);
  });

  it("reads as a sentence", () => {
    expect(escalationRuleText({ measure: "pain", threshold: 7 })).toBe("Pain at or above 7/10");
    expect(escalationRuleText({ measure: "pps", threshold: 30 })).toBe("PPS at or below 30%");
    expect(escalationRuleText({ measure: "ed_visit", threshold: null })).toBe("An ED visit");
  });
});

describe("the plan's lists", () => {
  it("CONTROL: the same goal, intervention, monitored item or measure twice is refused", () => {
    expect(CarePlanStructureSchema.safeParse({ goals: ["Comfort", "comfort"] }).success).toBe(false);
    expect(
      CarePlanStructureSchema.safeParse({ interventions: [{ item: "Call", by: null }, { item: "call", by: "np" }] }).success,
    ).toBe(false);
    expect(
      CarePlanStructureSchema.safeParse({
        escalation: [
          { measure: "pain", threshold: 7 },
          { measure: "pain", threshold: 8 },
        ],
      }).success,
    ).toBe(false);
    expect(CarePlanStructureSchema.safeParse({ monitoring: [{ item: "Pain", everyDays: 0, how: "phone" }] }).success).toBe(false);
  });

  it("each part is optional, and the review day can be cleared", () => {
    expect(CarePlanStructureSchema.safeParse({}).success).toBe(true);
    expect(CarePlanStructureSchema.safeParse({ reviewOn: null }).success).toBe(true);
    expect(CarePlanStructureSchema.safeParse({ reviewOn: "2026-02-30" }).success).toBe(false);
  });
});

describe("when monitoring falls due", () => {
  const last = { phone: "2026-10-20", visit: "2026-10-10", since: "2026-09-01" };

  it("counts from the last contact that counts for it", () => {
    expect(monitoringDue({ everyDays: 7, how: "phone" }, last, "2026-10-28")).toEqual({
      lastOn: "2026-10-20", dueOn: "2026-10-27", overdue: true,
    });
    expect(monitoringDue({ everyDays: 30, how: "visit" }, last, "2026-10-28")).toEqual({
      lastOn: "2026-10-10", dueOn: "2026-11-09", overdue: false,
    });
    // Either: the later of the two.
    expect(monitoringDue({ everyDays: 7, how: "any" }, last, "2026-10-28").lastOn).toBe("2026-10-20");
  });

  it("from when care began when there has been no contact; never for an as-needed item", () => {
    expect(monitoringDue({ everyDays: 7, how: "phone" }, { phone: null, visit: null, since: "2026-10-25" }, "2026-10-28")).toEqual({
      lastOn: null, dueOn: "2026-11-01", overdue: false,
    });
    expect(monitoringDue({ everyDays: null, how: "phone" }, last, "2026-10-28")).toEqual({ lastOn: "2026-10-20", dueOn: null, overdue: false });
  });

  it("CONTROL: due today is due, not overdue", () => {
    expect(monitoringDue({ everyDays: 8, how: "phone" }, last, "2026-10-28")).toEqual({
      lastOn: "2026-10-20", dueOn: "2026-10-28", overdue: false,
    });
  });
});
