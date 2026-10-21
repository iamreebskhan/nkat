/**
 * Control: every canon question that states a visit expects the code the CPT
 * suggester bills for that visit.
 *
 * cp-05 ("70 minutes of home visit time, established patient, Medicare")
 * expected G0318. The suggester bills 99350 alone there: G0318 starts at the
 * CMS total time plus 15 minutes, 110 on 99350 and 140 on 99345. The canon is
 * what the live eval grades the parser prompt against, so a wrong canon item
 * rewards the prompt for routing a visit to an add-on CMS does not pay.
 *
 * The convention, stated in the parser prompt's Medicare home-visit time rule:
 * a question about a visit's time names the prolonged add-on when the visit
 * carries one, and the base code when it does not. That is stronger than "is
 * one of the suggested codes", under which a 115-minute question expecting
 * 99350 would also pass.
 *
 * Needs no database and no API key. The file name matches CI's
 * "vitest run gold-standard" eval filter, where it runs harmlessly.
 */
import { describe, expect, it } from "vitest";

import {
  buildBands,
  suggestCodes,
  type CptSuggestion,
  type VisitCodeBands,
} from "@/lib/features/visits/cpt-suggester";

import { GOLD_STANDARD, type EvalQuestion } from "./gold-standard.fixtures";

/** The ladders as db/seed/0007_palliative_codes.sql stores them. */
const BANDS: VisitCodeBands = {
  newPatientHome: buildBands([
    { code: "99341", typicalMinutes: 15 },
    { code: "99342", typicalMinutes: 30 },
    { code: "99344", typicalMinutes: 60 },
    { code: "99345", typicalMinutes: 75 },
  ]),
  establishedPatientHome: buildBands([
    { code: "99347", typicalMinutes: 20 },
    { code: "99348", typicalMinutes: 30 },
    { code: "99349", typicalMinutes: 40 },
    { code: "99350", typicalMinutes: 60 },
  ]),
};

type Scenario = NonNullable<EvalQuestion["scenario"]>;

function suggest(s: Scenario): CptSuggestion {
  return suggestCodes({
    bands: BANDS,
    visitType: s.visitType,
    totalMinutes: s.totalMinutes,
    acpMinutes: s.acpMinutes ?? 0,
    payerCategory: s.payerCategory,
  });
}

/** The code a question about a visit's time names: the prolonged add-on, else the base code. */
function codeFor(s: CptSuggestion): string | undefined {
  return s.prolongedAddOns[0]?.code ?? s.base[0]?.code;
}

const SCENARIOS = GOLD_STANDARD.flatMap((q) =>
  q.scenario ? [{ q, s: q.scenario, suggestion: suggest(q.scenario) }] : [],
);

/** A CPT (5 digits) or HCPCS Level II (letter + 4 digits) code. */
const CODE_SHAPE = /^(?:\d{5}|[a-z]\d{4})$/i;

describe("gold-standard canon agrees with the CPT suggester", () => {
  it("CONTROL: each scenario question expects the add-on when the visit carries one, else the base code", () => {
    const wrong: string[] = [];
    for (const { q, suggestion } of SCENARIOS) {
      const want = codeFor(suggestion);
      if (q.expectedParse.cptCode !== want) {
        wrong.push(`${q.id}: expected ${want ?? "no code"}, canon says ${q.expectedParse.cptCode}`);
      }
      const billed = new Set(
        [...suggestion.base, ...suggestion.prolongedAddOns, ...suggestion.acpAddOns].map((c) =>
          c.code.toLowerCase(),
        ),
      );
      for (const sub of q.requiredSubstrings) {
        if (CODE_SHAPE.test(sub) && !billed.has(sub.toLowerCase())) {
          wrong.push(`${q.id}: requiredSubstrings names ${sub}, which the suggester does not bill for this visit`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ["established_patient_home", "established patient (99350)"],
    ["new_patient_home", "new patient (99345)"],
  ] as const)("has a Medicare %s scenario whose visit carries G0318", (visitType, label) => {
    const hit = SCENARIOS.some(
      ({ s, suggestion }) =>
        s.visitType === visitType &&
        s.payerCategory === "medicare" &&
        suggestion.prolongedAddOns.some((c) => c.code === "G0318"),
    );
    expect(hit, `no canon scenario on the ${label} ladder reaches G0318`).toBe(true);
  });

  it("has a Medicare home-visit scenario below the G0318 threshold", () => {
    const hit = SCENARIOS.some(
      ({ s, suggestion }) =>
        s.payerCategory === "medicare" &&
        suggestion.base.length > 0 &&
        suggestion.prolongedAddOns.length === 0,
    );
    expect(hit, "no Medicare canon scenario sits below the G0318 threshold").toBe(true);
  });
});
