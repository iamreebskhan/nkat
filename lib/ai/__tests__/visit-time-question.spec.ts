/**
 * A question that states a home visit's time names the code that visit bills.
 *
 * cp-07, "145 minutes of home visit time, new patient, Medicare", expects
 * G0318; Haiku answered 99345 in the eval and on production. The resolver
 * answers from the CPT suggester. Needs no API key and no database.
 */
import { describe, expect, it } from "vitest";

import { visitTimeQuestionCode } from "../visit-time-question";
import { GOLD_STANDARD } from "./gold-standard.fixtures";

describe("visitTimeQuestionCode", () => {
  it("CONTROL: answers every canon question that states a visit with the canon's code", () => {
    const scenarios = GOLD_STANDARD.filter((q) => q.scenario);
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
    for (const q of scenarios) {
      expect(visitTimeQuestionCode(q.query, q.expectedParse.payer ?? null), q.id).toBe(
        q.expectedParse.cptCode,
      );
    }
  });

  it("cp-07: 145 minutes, new patient, Medicare is 99345 + G0318, so G0318", () => {
    expect(visitTimeQuestionCode("145 minutes of home visit time, new patient, Medicare", "Medicare")).toBe(
      "G0318",
    );
  });

  it("stays on the base code below the G0318 threshold", () => {
    expect(visitTimeQuestionCode("139 minutes of home visit time, new patient, Medicare", "Medicare")).toBe(
      "99345",
    );
    expect(visitTimeQuestionCode("70 minutes of home visit time, established patient, Medicare", null)).toBe(
      "99350",
    );
  });

  it("names 99417 for a non-Medicare payer", () => {
    expect(visitTimeQuestionCode("145 minute home visit, new patient, Aetna", "Aetna")).toBe("99417");
  });

  it("answers cp-03's visit too: a new patient's 60 minutes at home is 99344", () => {
    expect(
      visitTimeQuestionCode("What's the new patient home visit rate for an NP at 60 minutes?", null),
    ).toBe("99344");
  });

  it.each([
    ["no time", "Medicare prolonged service add-on for home visit"],
    ["advance care planning", "Total billable for 60 minutes of advance care planning"],
    ["telehealth", "40 minutes established patient home telehealth visit"],
    ["not new or established", "90 minutes of home visit time, Medicare"],
    ["not a home visit", "115 minutes established patient office visit, Medicare"],
    ["two times", "Is 60 or 75 minutes the threshold for a new patient home visit?"],
  ])("leaves %s to the parser", (_why, query) => {
    expect(visitTimeQuestionCode(query, null)).toBeNull();
  });
});
