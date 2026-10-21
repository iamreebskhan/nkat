import { describe, expect, it } from "vitest";

import {
  acpBilledMinutes,
  acpOverTotalProblem,
  assignmentFromSuggestion,
  buildBands,
  suggestCodes,
  type SuggestVisitInput,
  type VisitCodeBands,
} from "../cpt-suggester";

/**
 * The ladders as db/seed/0007_palliative_codes.sql stores them — the same
 * figures the code descriptors, the AI parser prompt (anthropic.client.ts:156)
 * and the gold-standard eval all state.
 *
 * These tests previously asserted a fourth, lower ladder that existed only
 * inside cpt-suggester.ts: 99345 at 60 minutes rather than 75, and seven of
 * eight codes firing early, every one of them toward the higher-paying code.
 * The tests were pinning that open, which is why it survived. Changed
 * deliberately.
 */
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

const baseInput: SuggestVisitInput = {
  bands: BANDS,
  visitType: "established_patient_home",
  totalMinutes: 30,
  acpMinutes: 0,
  payerCategory: "non_medicare",
  isTelehealth: false,
};

/**
 * The document page does not build these ladders; it fetches them from
 * /api/billing/code-bands, so they arrive through JSON. JSON has no Infinity:
 * the open top band's maxMinutes comes back null. The in-memory BANDS above
 * never exercised that, which is how a 65-minute established visit came to
 * show a G0318 add-on with no base code at all (found in the browser).
 */
describe("suggestCodes — bands as they arrive over the API (JSON)", () => {
  const WIRE = JSON.parse(JSON.stringify(BANDS)) as VisitCodeBands;

  it("the wire shape really does carry the open top band as null", () => {
    expect(WIRE.establishedPatientHome.at(-1)?.maxMinutes).toBeNull();
    expect(WIRE.newPatientHome.at(-1)?.maxMinutes).toBeNull();
  });

  it.each([
    ["established_patient_home", 60, "99350"],
    ["established_patient_home", 65, "99350"],
    ["established_patient_home", 120, "99350"],
    ["new_patient_home", 75, "99345"],
    ["new_patient_home", 90, "99345"],
  ] as const)("%s at %d min over the wire → %s", (visitType, minutes, code) => {
    const r = suggestCodes({ ...baseInput, bands: WIRE, visitType, totalMinutes: minutes });
    expect(r.base[0]?.code).toBe(code);
    expect(r.inconclusive).toBe(false);
    expect(r.base[0]?.reason).toContain("+ band");
  });

  it("a Medicare visit past the CMS threshold gets its base code AND the G0318 add-on", () => {
    // G0318 starts at 110 minutes on 99350 (CMS: the 95-minute total time plus
    // a full 15). This used to fire at 65, past the CPT time of 60, which
    // billed a unit CMS does not pay for.
    const r = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 110, payerCategory: "medicare" });
    expect(r.base[0]?.code).toBe("99350");
    expect(r.base[0]?.units).toBe(1);
    expect(r.prolongedAddOns[0]?.code).toBe("G0318");
    expect(r.prolongedAddOns[0]?.units).toBe(1);
  });

  it("CONTROL: a 65-minute Medicare visit over the wire is the base code alone", () => {
    const r = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 65, payerCategory: "medicare" });
    expect(r.base[0]?.code).toBe("99350");
    expect(r.prolongedAddOns).toEqual([]);
  });

  /**
   * 99417 still takes its threshold from the ladder's open top band, the band
   * JSON turns to null. G0318 is keyed by code and no longer reads it, so the
   * Medicare case above no longer guards it: these do.
   */
  it.each([
    ["established_patient_home", 74, null],
    ["established_patient_home", 75, 1],
    ["new_patient_home", 89, null],
    ["new_patient_home", 90, 1],
  ] as const)("non-Medicare %s at %d min over the wire → 99417 × %s", (visitType, minutes, units) => {
    const r = suggestCodes({ ...baseInput, bands: WIRE, visitType, totalMinutes: minutes });
    if (units === null) {
      expect(r.prolongedAddOns).toEqual([]);
    } else {
      expect(r.prolongedAddOns.map((h) => h.code)).toEqual(["99417"]);
      expect(r.prolongedAddOns[0]?.units).toBe(units);
    }
  });

  it("CONTROL: a finite band is unchanged over the wire, edge flag included", () => {
    const mid = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 45 });
    expect(mid.base[0]?.code).toBe("99349");
    expect(mid.base[0]?.reason).toContain("40–59 band");
    const edge = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 59 });
    expect(edge.base[0]?.confidence).toBe("edge");
    const top = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 65 });
    expect(top.base[0]?.confidence).toBe("confirmed");
  });
});

describe("suggestCodes — base bands (vision §18.8 table)", () => {
  // New patient home — 99341 15–29, 99342 30–59, 99344 60–74, 99345 75+
  it.each([
    [15, "99341"],
    [29, "99341"],
    [30, "99342"],
    [44, "99342"],
    [59, "99342"],
    [60, "99344"],
    [74, "99344"],
    [75, "99345"],
    [120, "99345"],
  ])("new_patient_home %d min → %s", (minutes, code) => {
    const r = suggestCodes({ ...baseInput, visitType: "new_patient_home", totalMinutes: minutes });
    expect(r.base[0]?.code).toBe(code);
  });

  // Established patient home — 99347 20–29, 99348 30–39, 99349 40–59, 99350 60+
  it.each([
    [20, "99347"],
    [29, "99347"],
    [30, "99348"],
    [39, "99348"],
    [40, "99349"],
    [59, "99349"],
    [60, "99350"],
    [120, "99350"],
  ])("established_patient_home %d min → %s", (minutes, code) => {
    const r = suggestCodes({ ...baseInput, totalMinutes: minutes });
    expect(r.base[0]?.code).toBe(code);
    // A home E/M is reported once per date of service, whatever the time.
    expect(r.base[0]?.units).toBe(1);
  });

  it("flags `edge` when at top of band ±1 min", () => {
    // 99347 now runs 20–29, so the top edge is 29 (was 24 under the old ladder).
    const r = suggestCodes({ ...baseInput, totalMinutes: 29 });
    expect(r.base[0]?.code).toBe("99347");
    expect(r.base[0]?.confidence).toBe("edge");
  });

  it("suggests nothing below the lowest stated time, rather than guessing", () => {
    // The old ladder started at 0, so a 3-minute visit was silently suggested
    // as a full home visit. No code's time is met here; the clinician chooses.
    const r = suggestCodes({ ...baseInput, totalMinutes: 3 });
    expect(r.base).toEqual([]);
    expect(r.inconclusive).toBe(true);
  });

  it("derives the prolonged-service cap from the top band, not a constant", () => {
    // New-patient top is 75, so 90 minutes is 15 past the cap = 1 unit.
    const r = suggestCodes({
      ...baseInput,
      visitType: "new_patient_home",
      totalMinutes: 90,
    });
    expect(r.base[0]?.code).toBe("99345");
    expect(r.prolongedAddOns[0]?.code).toBe("99417");
    expect(r.prolongedAddOns[0]?.reason).toContain("75-min cap");
  });

  it("flags `confirmed` mid-band", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 30 });
    expect(r.base[0]?.confidence).toBe("confirmed");
  });

  it("returns no base for advance_care_planning visit type", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "advance_care_planning",
      totalMinutes: 0,
    });
    expect(r.base).toEqual([]);
  });
});

describe("suggestCodes — prolonged service (G0318 / 99417)", () => {
  it("does NOT add prolonged when totalMinutes equals top of band", () => {
    // established top is 60 (99350) — exactly 60 = no overflow
    const r = suggestCodes({ ...baseInput, totalMinutes: 60 });
    expect(r.prolongedAddOns).toEqual([]);
  });

  it("adds 99417 (non-Medicare) past the 60-min top threshold", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 75 });
    expect(r.prolongedAddOns[0]?.code).toBe("99417");
  });

  it("adds G0318 (Medicare) at the CMS threshold, not the CPT one", () => {
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 110,
      payerCategory: "medicare",
    });
    expect(r.prolongedAddOns[0]?.code).toBe("G0318");
    expect(r.prolongedAddOns[0]?.units).toBe(1);
  });

  /**
   * The unit count is asserted anchored at the start of the reason, and
   * alongside the computed attributedMinutes, because the loose
   * `toContain("4 unit")` this test used to carry could not fail: the Medicare
   * note the reason ends with is the literal "Max 4 units per visit.", so
   * deleting the cap entirely still produced a reason containing "4 unit" —
   * "10 unit(s). 150 minutes past the 60-min cap. … Max 4 units per visit."
   * The leading count is what the clinician reads: CodeRow on the document
   * screen renders `reason` verbatim under the code. So that is the number to
   * pin, anchored where the boilerplate cannot reach it.
   */
  it("caps Medicare G0318 at 4 units even when time is huge", () => {
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 60 + 15 * 10, // 210 min: 7 full increments past the CMS 95
      payerCategory: "medicare",
    });
    expect(r.prolongedAddOns[0]?.reason).toMatch(/^4 unit\(s\)\./);
    expect(r.prolongedAddOns[0]?.units).toBe(4);
    expect(r.prolongedAddOns[0]?.attributedMinutes).toBe(4 * 15);
  });

  it("CONTROL: suggests G0318 × 4 at 170 minutes — the count is a field, not only reason text", () => {
    // The count used to exist only inside `reason`, so the document page saved
    // the code alone and the bill priced one unit whatever the time.
    const r = suggestCodes({ ...baseInput, totalMinutes: 170, payerCategory: "medicare" });
    expect(r.prolongedAddOns[0]?.code).toBe("G0318");
    expect(r.prolongedAddOns[0]?.units).toBe(4);
  });

  it("counts the units the time supports below the cap — 4 is a ceiling, not a constant", () => {
    // A cap asserted only at an extreme is equally satisfied by hardcoding 4,
    // which would over-bill every shorter Medicare visit. Three full
    // increments past the CMS total (95 for 99350) is three units; the fourth
    // is the last one allowed; the fifth is refused.
    const three = suggestCodes({ ...baseInput, totalMinutes: 95 + 15 * 3, payerCategory: "medicare" });
    expect(three.prolongedAddOns[0]?.reason).toMatch(/^3 unit\(s\)\./);
    expect(three.prolongedAddOns[0]?.units).toBe(3);
    expect(three.prolongedAddOns[0]?.attributedMinutes).toBe(3 * 15);

    const four = suggestCodes({ ...baseInput, totalMinutes: 95 + 15 * 4, payerCategory: "medicare" });
    expect(four.prolongedAddOns[0]?.reason).toMatch(/^4 unit\(s\)\./);
    expect(four.prolongedAddOns[0]?.units).toBe(4);

    const five = suggestCodes({ ...baseInput, totalMinutes: 95 + 15 * 5, payerCategory: "medicare" });
    expect(five.prolongedAddOns[0]?.reason).toMatch(/^4 unit\(s\)\./);
    expect(five.prolongedAddOns[0]?.units).toBe(4);
    expect(five.prolongedAddOns[0]?.attributedMinutes).toBe(4 * 15);
  });

  it("does NOT cap 99417 at 4 — non-Medicare bills as billed", () => {
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 60 + 15 * 6, // 6 increments past cap
      payerCategory: "non_medicare",
    });
    // Anchored for the same reason as the Medicare case above. This one passed
    // only by the accident that the non-Medicare note carries no digits; a
    // reworded note would have made it as inert as its sibling was.
    expect(r.prolongedAddOns[0]?.reason).toMatch(/^6 unit\(s\)\./);
    expect(r.prolongedAddOns[0]?.units).toBe(6);
    expect(r.prolongedAddOns[0]?.attributedMinutes).toBe(6 * 15);
  });

  it("adds prolonged for new_patient_home past 75-min threshold", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "new_patient_home",
      totalMinutes: 90,
    });
    expect(r.prolongedAddOns[0]?.code).toBe("99417");
  });

  it("does NOT add prolonged for ACP-only visit", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "advance_care_planning",
      totalMinutes: 100,
    });
    expect(r.prolongedAddOns).toEqual([]);
  });
});

/**
 * The unit counts at every boundary, now that the count reaches the bill.
 *
 * While the count lived only in reason text, rounding a part-block up and
 * starting G0318 at the CPT time were an over-statement nobody was billed for.
 * Once units are priced they are over-billing, so the math is the payers':
 *
 *   - 99417 (CPT): one unit per FULL 15 minutes past the top code's time.
 *     99350 is 60 minutes, so the first unit is at 75; 99345 is 75, so 90.
 *   - G0318 (CMS CY2023 PFS): one unit per FULL 15 minutes past the RUC total
 *     time, 95 for 99350 and 125 for 99345, so the first unit is at 110 and
 *     140. Pallio caps it at 4 per visit (vision §18.8).
 *   - 99498 (CMS ACP FAQ): 99497 covers 16–45 minutes; each 99498 unit is 30
 *     more past the midpoint, so 46–75 ×1, 76–105 ×2, 106–135 ×3.
 */
describe("suggestCodes — add-on units at every boundary (CMS / CPT)", () => {
  const prolonged = (visitType: SuggestVisitInput["visitType"], payer: SuggestVisitInput["payerCategory"]) =>
    (totalMinutes: number) =>
      suggestCodes({ ...baseInput, visitType, totalMinutes, payerCategory: payer }).prolongedAddOns;

  it.each([
    [109, null],
    [110, 1],
    [124, 1],
    [125, 2],
    [155, 4],
    [170, 4],
  ] as const)("G0318, established (99350): %d min → %s unit(s)", (minutes, units) => {
    const hits = prolonged("established_patient_home", "medicare")(minutes);
    if (units === null) {
      expect(hits).toEqual([]);
    } else {
      expect(hits.map((h) => h.code)).toEqual(["G0318"]);
      expect(hits[0]?.units).toBe(units);
    }
  });

  it.each([
    [139, null],
    [140, 1],
    [155, 2],
  ] as const)("G0318, new patient (99345): %d min → %s unit(s)", (minutes, units) => {
    const hits = prolonged("new_patient_home", "medicare")(minutes);
    if (units === null) {
      expect(hits).toEqual([]);
    } else {
      expect(hits.map((h) => h.code)).toEqual(["G0318"]);
      expect(hits[0]?.units).toBe(units);
    }
  });

  it.each([
    [61, null],
    [74, null],
    [75, 1],
    [89, 1],
    [90, 2],
  ] as const)("99417, established (99350 at 60): %d min → %s unit(s)", (minutes, units) => {
    const hits = prolonged("established_patient_home", "non_medicare")(minutes);
    if (units === null) {
      expect(hits).toEqual([]);
    } else {
      expect(hits.map((h) => h.code)).toEqual(["99417"]);
      expect(hits[0]?.units).toBe(units);
    }
  });

  it.each([
    [89, null],
    [90, 1],
  ] as const)("99417, new patient (99345 at 75): %d min → %s unit(s)", (minutes, units) => {
    const hits = prolonged("new_patient_home", "non_medicare")(minutes);
    if (units === null) {
      expect(hits).toEqual([]);
    } else {
      expect(hits.map((h) => h.code)).toEqual(["99417"]);
      expect(hits[0]?.units).toBe(units);
    }
  });

  it("suggests no G0318 when the ladder's top code has no CMS total, rather than guessing one", () => {
    // An org whose 99350 carries no stated time builds its established ladder
    // to 99349. CMS publishes G0318's start only for 99345 and 99350, so the
    // honest answer is none; falling back to the ladder's CPT time is the
    // threshold that put G0318 on Medicare visits CMS does not pay.
    const noTop: VisitCodeBands = {
      ...BANDS,
      establishedPatientHome: buildBands([
        { code: "99347", typicalMinutes: 20 },
        { code: "99348", typicalMinutes: 30 },
        { code: "99349", typicalMinutes: 40 },
      ]),
    };
    const medicare = suggestCodes({ ...baseInput, bands: noTop, totalMinutes: 120, payerCategory: "medicare" });
    expect(medicare.base[0]?.code).toBe("99349");
    expect(medicare.prolongedAddOns).toEqual([]);
    // CONTROL: the same ladder still prices 99417 from its top time, so the
    // empty list above is G0318's keying and not a ladder that codes nothing.
    const commercial = suggestCodes({ ...baseInput, bands: noTop, totalMinutes: 120 });
    expect(commercial.prolongedAddOns.map((h) => h.code)).toEqual(["99417"]);
  });

  it("names the CMS threshold in the G0318 reason, keeping the leading count", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 140, payerCategory: "medicare" });
    expect(r.prolongedAddOns[0]?.reason).toMatch(/^3 unit\(s\)\./);
    expect(r.prolongedAddOns[0]?.reason).toContain("95-minute CMS total for 99350");
    expect(r.prolongedAddOns[0]?.reason).toContain("starts at 110");
    // G0318 dates from CY2023; it never "replaced 99417 in 2024".
    expect(r.prolongedAddOns[0]?.reason).not.toMatch(/2024/);
  });

  it.each([
    [45, null],
    [46, 1],
    [75, 1],
    [76, 2],
    [105, 2],
    [106, 3],
  ] as const)("99498: %d ACP min → %s unit(s)", (acpMinutes, units) => {
    // A visit as long as its ACP conversation: more ACP than visit codes
    // nothing at all (see "more ACP minutes than the visit's total").
    const r = suggestCodes({ ...baseInput, totalMinutes: acpMinutes, acpMinutes });
    const add = r.acpAddOns.find((c) => c.code === "99498");
    if (units === null) {
      expect(add).toBeUndefined();
    } else {
      expect(add?.reason).toMatch(new RegExp(`^${units} additional 30-min unit\\(s\\)\\.`));
      expect(add?.units).toBe(units);
    }
    expect(r.acpAddOns[0]?.code).toBe("99497");
    expect(r.acpAddOns[0]?.units).toBe(1);
  });
});

/**
 * ACP minutes are not E/M time as well — neither for the add-on nor for the
 * base code.
 *
 * The document page sends the visit's whole start-to-stop time, the ACP
 * conversation inside it, and the ACP minutes beside it. CPT counts no time
 * spent on a separately reported service toward E/M time, so the minutes
 * billed as 99497/99498 come off the time both the base code and the add-on
 * are chosen on. Counting them twice could add an add-on the E/M time did not
 * reach, and with units priced it multiplied one that did. The base code was
 * still chosen on the whole total, which put a 50-minute visit with 20 ACP
 * minutes at 99349 where its 30 E/M minutes are 99348. Under 16 ACP minutes
 * nothing bills as ACP, so nothing comes out.
 */
describe("suggestCodes — ACP minutes are not counted again as prolonged time", () => {
  it("CONTROL: 170 Medicare minutes with 60 of ACP bill G0318 × 1, not × 4", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 170, acpMinutes: 60, payerCategory: "medicare" });
    // The base code is chosen on the same 110 E/M minutes, and says so.
    expect(r.base.map((c) => c.code)).toEqual(["99350"]);
    expect(r.base[0]?.reason).toMatch(/^110 min in the 60\+ band/);
    // 110 minutes of E/M time: the first G0318 unit and no more.
    expect(r.prolongedAddOns.map((h) => h.code)).toEqual(["G0318"]);
    expect(r.prolongedAddOns[0]?.units).toBe(1);
    expect(r.prolongedAddOns[0]?.reason).toMatch(/^1 unit\(s\)\./);
    expect(r.prolongedAddOns[0]?.reason).toContain("the 60 ACP minutes bill as 99497/99498");
    expect(r.acpAddOns.map((c) => [c.code, c.units])).toEqual([
      ["99497", 1],
      ["99498", 1],
    ]);
  });

  it("CONTROL: 150 commercial minutes with 60 of ACP bill 99417 × 2, not × 6", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 150, acpMinutes: 60 });
    expect(r.prolongedAddOns.map((h) => [h.code, h.units])).toEqual([["99417", 2]]);
  });

  it("CONTROL: drops the add-on entirely when the E/M time left is under its threshold", () => {
    // 120 minutes, 45 of them ACP: 75 of E/M time, short of G0318's 110.
    const r = suggestCodes({ ...baseInput, totalMinutes: 120, acpMinutes: 45, payerCategory: "medicare" });
    expect(r.prolongedAddOns).toEqual([]);
    expect(r.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
  });

  it("keeps ACP minutes too few to bill as ACP in the E/M time", () => {
    // Under 16 minutes no 99497 is billed, so that time was not reported
    // separately and still counts toward the visit: 110 minutes is G0318 × 1.
    const r = suggestCodes({ ...baseInput, totalMinutes: 110, acpMinutes: 15, payerCategory: "medicare" });
    expect(r.acpAddOns).toEqual([]);
    expect(r.prolongedAddOns.map((h) => [h.code, h.units])).toEqual([["G0318", 1]]);
    expect(r.prolongedAddOns[0]?.reason).not.toContain("ACP minutes");
  });

  it.each([
    ["BANDS", BANDS],
    ["WIRE", JSON.parse(JSON.stringify(BANDS)) as VisitCodeBands],
  ] as const)("CONTROL: 70 minutes with 30 of ACP is 99349 on its 40 E/M minutes, not 99350 (%s)", (_, bands) => {
    // This test used to pin the base code on the whole total, so that taking
    // ACP time out of the base choice too was decided deliberately. It was.
    const r = suggestCodes({ ...baseInput, bands, totalMinutes: 70, acpMinutes: 30 });
    expect(r.base.map((c) => c.code)).toEqual(["99349"]);
    expect(r.base[0]?.attributedMinutes).toBe(40);
    expect(r.prolongedAddOns).toEqual([]);
    expect(r.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
  });
});

/**
 * The base code is chosen on E/M time: the visit's total less the minutes
 * billed as 99497/99498. Only minutes that actually bill as ACP come out —
 * under 16 nothing is reported separately, so that time stays E/M time.
 */
describe("suggestCodes — the base code is chosen on E/M time", () => {
  const WIRE = JSON.parse(JSON.stringify(BANDS)) as VisitCodeBands;
  const LADDERS = [
    ["BANDS", BANDS],
    ["WIRE", WIRE],
  ] as const;

  it.each(LADDERS)("CONTROL: 50 Medicare minutes with 20 of ACP are 99348 + 99497, not 99349 (%s)", (_, bands) => {
    const r = suggestCodes({ ...baseInput, bands, totalMinutes: 50, acpMinutes: 20, payerCategory: "medicare" });
    expect(r.base.map((c) => c.code)).toEqual(["99348"]);
    expect(r.base[0]?.reason).toMatch(/^30 min in the 30–39 band/);
    expect(r.base[0]?.reason).toContain(
      "Counted on 30 of the 50 minutes; the 20 ACP minutes bill as 99497/99498.",
    );
    expect(r.base[0]?.attributedMinutes).toBe(30);
    expect(r.base[0]?.units).toBe(1);
    expect(r.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
    expect(r.baseNote).toBeNull();
    expect(assignmentFromSuggestion(r)).toEqual({ codes: ["99348", "99497"], units: {} });
  });

  it.each([10, 15])("CONTROL: 50 minutes with %d ACP minutes — too few to bill — stay 99349 on the whole total", (acpMinutes) => {
    const r = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 50, acpMinutes, payerCategory: "medicare" });
    expect(r.base.map((c) => c.code)).toEqual(["99349"]);
    expect(r.base[0]?.reason).toMatch(/^50 min in the 40–59 band/);
    expect(r.base[0]?.reason).not.toContain("ACP minutes");
    expect(r.base[0]?.attributedMinutes).toBe(50);
    expect(r.acpAddOns).toEqual([]);
  });

  it("the ACP floor: 15 minutes leave the base on 50, 16 take it to 34 — mid-band, with 99497 on the edge", () => {
    const fifteen = suggestCodes({ ...baseInput, totalMinutes: 50, acpMinutes: 15, payerCategory: "medicare" });
    expect(fifteen.base.map((c) => c.code)).toEqual(["99349"]);
    const sixteen = suggestCodes({ ...baseInput, totalMinutes: 50, acpMinutes: 16, payerCategory: "medicare" });
    expect(sixteen.base.map((c) => [c.code, c.confidence])).toEqual([["99348", "confirmed"]]);
    expect(sixteen.acpAddOns.map((c) => [c.code, c.confidence])).toEqual([["99497", "edge"]]);
  });

  it("the edge flag follows E/M time: 50 minutes with 21 of ACP are 99347 at the top of its band", () => {
    const r = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 50, acpMinutes: 21, payerCategory: "medicare" });
    expect(r.base.map((c) => [c.code, c.confidence])).toEqual([["99347", "edge"]]);
    expect(r.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
  });

  it.each(LADDERS)("new patient: 45 Medicare minutes with 20 of ACP are 99341, 90 commercial with 20 are 99344 and no 99417 (%s)", (_, bands) => {
    const short = suggestCodes({
      ...baseInput,
      bands,
      visitType: "new_patient_home",
      totalMinutes: 45,
      acpMinutes: 20,
      payerCategory: "medicare",
    });
    expect(short.base.map((c) => c.code)).toEqual(["99341"]);
    expect(short.base[0]?.reason).toMatch(/^25 min in the 15–29 band for a new patient home visit\./);
    expect(short.acpAddOns.map((c) => c.code)).toEqual(["99497"]);

    const long = suggestCodes({ ...baseInput, bands, visitType: "new_patient_home", totalMinutes: 90, acpMinutes: 20 });
    expect(long.base.map((c) => c.code)).toEqual(["99344"]);
    expect(long.prolongedAddOns).toEqual([]);
    expect(long.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
  });

  it("an all-ACP home visit codes 99497 alone and says why there is no base code", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 30, acpMinutes: 30 });
    expect(r.base).toEqual([]);
    expect(r.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
    expect(r.inconclusive).toBe(false);
    expect(r.baseNote).toMatch(/30 minutes/);
    expect(r.baseNote).toMatch(/20 minutes 99347 needs/);
    expect(r.baseNote).toBe(
      "No home-visit E/M code on time: with the 30 ACP minutes billed as 99497/99498 taken out, 0 of the 30 minutes are E/M time, short of the 20 minutes 99347 needs.",
    );
    // 45 minutes, 30 of them ACP: 15 of E/M time, still short.
    const fortyFive = suggestCodes({ ...baseInput, bands: WIRE, totalMinutes: 45, acpMinutes: 30 });
    expect(fortyFive.base).toEqual([]);
    expect(fortyFive.baseNote).toContain("15 of the 45 minutes are E/M time");
    // The new-patient ladder names its own first code.
    const newPatient = suggestCodes({ ...baseInput, visitType: "new_patient_home", totalMinutes: 30, acpMinutes: 20 });
    expect(newPatient.base).toEqual([]);
    expect(newPatient.baseNote).toContain("short of the 15 minutes 99341 needs");
  });

  it("CONTROL: no note where taking out ACP time did not cost the base code", () => {
    // Coded: a 30-minute visit with no ACP.
    const coded = suggestCodes({ ...baseInput, totalMinutes: 30, acpMinutes: 0 });
    expect(coded.base.map((c) => c.code)).toEqual(["99348"]);
    expect(coded.baseNote).toBeNull();
    // 18 minutes would not have coded on the whole total either.
    const short = suggestCodes({ ...baseInput, totalMinutes: 18, acpMinutes: 16 });
    expect(short.base).toEqual([]);
    expect(short.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
    expect(short.baseNote).toBeNull();
    // No time, no ACP: inconclusive, which already has its own line.
    const empty = suggestCodes({ ...baseInput, totalMinutes: 10, acpMinutes: 0 });
    expect(empty.inconclusive).toBe(true);
    expect(empty.baseNote).toBeNull();
    // Types with no home ladder: the ACP codes are the codes, or nothing is.
    for (const visitType of ["advance_care_planning", "inpatient_consult", "non_billable"] as const) {
      const r = suggestCodes({ ...baseInput, visitType, totalMinutes: 45, acpMinutes: 30 });
      expect(r.base, visitType).toEqual([]);
      expect(r.baseNote, visitType).toBeNull();
    }
    expect(suggestCodes({ ...baseInput, visitType: "advance_care_planning", totalMinutes: 45, acpMinutes: 30 }).acpAddOns.map((c) => c.code)).toEqual(["99497"]);
  });

  /**
   * ACP time is spent during the visit. This used to stop E/M time at 0 and
   * still suggest 99497 on all 40 ACP minutes of a 30-minute visit — seen on
   * localhost, and nothing downstream refused it. Nothing is coded now until
   * the times or the ACP minutes are corrected, and the suggestion says why.
   */
  it("more ACP minutes than the visit's total: nothing is coded, and the suggestion says why", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 30, acpMinutes: 40 });
    expect(r.base).toEqual([]);
    expect(r.prolongedAddOns).toEqual([]);
    expect(r.acpAddOns).toEqual([]);
    expect(r.inconclusive).toBe(true);
    expect(r.baseNote).toBeNull();
    expect(r.acpOverTotal).toBe(
      "40 minutes of ACP is more than the visit's 30 minutes in total. ACP time is part of the visit: correct the start and stop times, or the ACP minutes.",
    );
    expect(assignmentFromSuggestion(r)).toEqual({ codes: [], units: {} });
  });

  it("CONTROL: ACP minutes equal to the total still code, with nothing to correct", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 30, acpMinutes: 30 });
    expect(r.acpAddOns.map((c) => c.code)).toEqual(["99497"]);
    expect(r.acpOverTotal).toBeNull();
  });

  it("over the total by fewer than 16 ACP minutes is still refused: the record is wrong either way", () => {
    // 10 ACP minutes bill nothing as ACP, but a 5-minute visit cannot hold them.
    const r = suggestCodes({ ...baseInput, totalMinutes: 5, acpMinutes: 10 });
    expect(r.acpOverTotal).toMatch(/^10 minutes of ACP is more than the visit's 5 minutes/);
  });

  it("keeps a telehealth visit's modifier while nothing is coded", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 30, acpMinutes: 40, isTelehealth: true });
    expect(r.acpOverTotal).not.toBeNull();
    expect(r.modifiers.map((m) => m.modifier)).toEqual(["95"]);
  });

  it("a Not billed visit codes nothing either way, and says nothing about the minutes", () => {
    const r = suggestCodes({ ...baseInput, visitType: "non_billable", totalMinutes: 30, acpMinutes: 40 });
    expect(r.nonBillable).toBe(true);
    expect(r.acpOverTotal).toBeNull();
  });
});

describe("acpOverTotalProblem and acpBilledMinutes", () => {
  it("is null while the ACP minutes fit in the visit, and with no ACP at all", () => {
    expect(acpOverTotalProblem(0, 0)).toBeNull();
    expect(acpOverTotalProblem(30, 30)).toBeNull();
    expect(acpOverTotalProblem(20, 45)).toBeNull();
    expect(acpOverTotalProblem(null, null)).toBeNull();
    expect(acpOverTotalProblem(undefined, 30)).toBeNull();
    // A negative total is a different defect (stop before start), not this one.
    expect(acpOverTotalProblem(0, -5)).toBeNull();
  });

  it("counts a visit with no total yet as 0 minutes", () => {
    expect(acpOverTotalProblem(20, null)).toBe(
      "20 minutes of ACP is more than the visit's 0 minutes in total. ACP time is part of the visit: correct the start and stop times, or the ACP minutes.",
    );
  });

  it("says minute, not minutes, for one", () => {
    expect(acpOverTotalProblem(1, 0)).toMatch(/^1 minute of ACP is more than the visit's 0 minutes/);
    expect(acpOverTotalProblem(2, 1)).toMatch(/the visit's 1 minute in total/);
  });

  it("acpBilledMinutes: every ACP minute from 16, none below", () => {
    expect(acpBilledMinutes(0)).toBe(0);
    expect(acpBilledMinutes(15)).toBe(0);
    expect(acpBilledMinutes(16)).toBe(16);
    expect(acpBilledMinutes(60)).toBe(60);
  });
});

describe("assignmentFromSuggestion — what the document page saves", () => {
  it("carries the G0318 count beside the codes", () => {
    const s = suggestCodes({ ...baseInput, totalMinutes: 170, payerCategory: "medicare" });
    expect(assignmentFromSuggestion(s)).toEqual({ codes: ["99350", "G0318"], units: { G0318: 4 } });
  });

  it("orders the codes base, prolonged, then ACP", () => {
    // 180 minutes with 80 of ACP leaves 100 of E/M time: 99417 × 2.
    const s = suggestCodes({ ...baseInput, totalMinutes: 180, acpMinutes: 80 });
    expect(assignmentFromSuggestion(s)).toEqual({
      codes: ["99350", "99417", "99497", "99498"],
      units: { "99417": 2, "99498": 2 },
    });
  });

  it("writes no units when every code is one unit", () => {
    // 60 minutes, 30 of them ACP: 30 of E/M time is 99348.
    const s = suggestCodes({ ...baseInput, totalMinutes: 60, acpMinutes: 30 });
    expect(assignmentFromSuggestion(s)).toEqual({ codes: ["99348", "99497"], units: {} });
  });

  it("assigns nothing on a non-billable visit", () => {
    const s = suggestCodes({ ...baseInput, visitType: "non_billable", totalMinutes: 170, acpMinutes: 80 });
    expect(assignmentFromSuggestion(s)).toEqual({ codes: [], units: {} });
  });
});

/**
 * Every boundary these test names claim, checked at the boundary itself.
 *
 * They used to be named for thresholds they never went near: "below 16
 * minutes" tested 15 only, "between 16–45" tested 30 only, and the unit count
 * was `toContain("2")` at 90 ACP minutes, where rounding up and rounding down
 * both give 2. Moving the floor to 21, rounding 99498 down, halving either
 * attributedMinutes and flattening the edge flag were five separate one-line
 * breakages that left all of this green. A 16-to-20-minute goals-of-care
 * conversation is the common short ACP visit: with the floor moved it is
 * suggested no 99497 at all, so the work never reaches the superbill.
 */
describe("suggestCodes — ACP add-ons (99497 / 99498)", () => {
  // The visit is never shorter than its ACP conversation: more ACP than visit
  // codes nothing at all (see "more ACP minutes than the visit's total").
  const acp = (acpMinutes: number) =>
    suggestCodes({ ...baseInput, totalMinutes: Math.max(baseInput.totalMinutes, acpMinutes), acpMinutes });
  const codes = (acpMinutes: number) => acp(acpMinutes).acpAddOns.map((c) => c.code);

  it("emits no ACP code below 16 minutes", () => {
    expect(acp(0).acpAddOns).toEqual([]);
    expect(acp(15).acpAddOns).toEqual([]);
    // The floor itself: 16 is the first minute that bills, so the "below"
    // above is a boundary and not an open-ended "somewhere under 30".
    expect(codes(16)).toEqual(["99497"]);
  });

  it("emits 99497 only between 16–45 ACP minutes", () => {
    for (const minutes of [16, 30, 45]) {
      expect(codes(minutes), `${minutes} ACP min`).toEqual(["99497"]);
    }
    // 46 is where the add-on starts, the other end of the same window.
    expect(codes(46)).toEqual(["99497", "99498"]);
  });

  it("flags the first minutes over the floor `edge`, so the clinician confirms", () => {
    // Within a minute of the floor the conversation may or may not have met
    // it; past that it has. Flattening this to "confirmed" would submit the
    // borderline ones without asking.
    expect(acp(16).acpAddOns[0]?.confidence).toBe("edge");
    expect(acp(17).acpAddOns[0]?.confidence).toBe("edge");
    expect(acp(18).acpAddOns[0]?.confidence).toBe("confirmed");
    expect(acp(30).acpAddOns[0]?.confidence).toBe("confirmed");
  });

  it("emits 99497 + 99498 at 46+ ACP minutes", () => {
    expect(codes(60)).toEqual(["99497", "99498"]);
  });

  it("99498 adds a unit per 30 ACP minutes past 45: 46–75 ×1, 76–105 ×2, 106–135 ×3", () => {
    const units = (acpMinutes: number) =>
      acp(acpMinutes).acpAddOns.find((c) => c.code === "99498")?.reason;
    expect(units(46)).toMatch(/^1 additional 30-min unit\(s\)\./);
    expect(units(90)).toMatch(/^2 additional 30-min unit\(s\)\./);
    // 91 used to be pinned at 3, from counting past 30 rather than 45:
    // (91-30)/30 rounded up. The CMS ACP FAQ counts each 99498 from 99497's
    // 45 minutes, so 91 is 46 past it — two units. Counting from 30 also
    // billed 61–75 ACP minutes as two units where CMS pays one.
    expect(units(91)).toMatch(/^2 additional 30-min unit\(s\)\./);
    expect(units(119)).toMatch(/^3 additional 30-min unit\(s\)\./);
  });

  it("attributes the minutes each ACP code stands for", () => {
    // attributedMinutes is internal today — CodeRow on the document screen
    // destructures only code, reason, confidence and kind, so the {...c}
    // spread drops it, and nothing persists it. It is pinned rather than left
    // untested because an unasserted field drifts silently and this is the
    // only statement anywhere of how the conversation splits between the two
    // codes: 99497 carries it up to 45 minutes, 99498 carries 30 per unit.
    // If it is ever shown or billed, these are the numbers it must show.
    expect(acp(30).acpAddOns[0]?.attributedMinutes).toBe(30);
    expect(acp(60).acpAddOns[0]?.attributedMinutes).toBe(45);
    expect(acp(120).acpAddOns[0]?.attributedMinutes).toBe(45);
    expect(acp(60).acpAddOns[1]?.attributedMinutes).toBe(30);
    expect(acp(90).acpAddOns[1]?.attributedMinutes).toBe(60);
  });

  it("base + ACP stack — both present in one visit", () => {
    // The base code is chosen on the 30 minutes left once the 30 ACP minutes
    // are taken out; a 30-minute visit that was all ACP has no base code.
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 60,
      acpMinutes: 30,
    });
    expect(r.base[0]?.code).toBe("99348");
    expect(r.acpAddOns[0]?.code).toBe("99497");
    // 99497 is reported once; more time is 99498, not a second 99497.
    expect(r.acpAddOns[0]?.units).toBe(1);
  });
});

describe("suggestCodes — telehealth modifier", () => {
  it("emits modifier 95 when isTelehealth=true (default audio+video)", () => {
    const r = suggestCodes({ ...baseInput, isTelehealth: true });
    expect(r.modifiers.find((m) => m.modifier === "95")).toBeTruthy();
  });

  it("emits modifier 95 when modality explicitly audio_video", () => {
    const r = suggestCodes({
      ...baseInput,
      isTelehealth: true,
      telehealthModality: "audio_video",
    });
    expect(r.modifiers.find((m) => m.modifier === "95")).toBeTruthy();
  });

  it("emits modifier 93 when modality is audio_only", () => {
    const r = suggestCodes({
      ...baseInput,
      isTelehealth: true,
      telehealthModality: "audio_only",
    });
    expect(r.modifiers.find((m) => m.modifier === "93")).toBeTruthy();
    expect(r.modifiers.find((m) => m.modifier === "95")).toBeFalsy();
  });

  it("does NOT emit any telehealth modifier by default", () => {
    const r = suggestCodes({ ...baseInput });
    expect(r.modifiers).toEqual([]);
  });
});

describe("suggestCodes — telehealth is a modality, not a band (audit R22)", () => {
  // A new patient seen on the old "Telehealth" type coded on the established
  // ladder: 99350 + 99417 at 65 minutes. The band now comes only from new vs
  // established; telehealth adds its modifier on top.
  it("codes a new patient over video on the new-patient ladder: 99344, 95, no 99417", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "new_patient_home",
      totalMinutes: 65,
      isTelehealth: true,
    });
    expect(r.base.map((c) => c.code)).toEqual(["99344"]);
    expect(r.prolongedAddOns).toEqual([]);
    expect(r.modifiers.map((m) => m.modifier)).toEqual(["95"]);
  });

  it("never moves the band: established at 45 min is the same code either way", () => {
    const inPerson = suggestCodes({ ...baseInput, totalMinutes: 45, isTelehealth: false });
    const video = suggestCodes({ ...baseInput, totalMinutes: 45, isTelehealth: true });
    expect(inPerson.base[0]?.code).toBe("99349");
    expect(video.base).toEqual(inPerson.base);
    expect(video.prolongedAddOns).toEqual(inPerson.prolongedAddOns);
    expect(inPerson.modifiers).toEqual([]);
    expect(video.modifiers.map((m) => m.modifier)).toEqual(["95"]);
  });
});

describe("suggestCodes — degenerate inputs", () => {
  it("inconclusive=true when no base or ACP applies", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "advance_care_planning",
      totalMinutes: 0,
      acpMinutes: 0,
    });
    expect(r.inconclusive).toBe(true);
  });

  it("negative totalMinutes returns no suggestion", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: -5 });
    expect(r.base).toEqual([]);
    expect(r.inconclusive).toBe(true);
  });
});

describe("suggestCodes — Not billed (audit R18)", () => {
  // A bereavement follow-up or a caregiver-only visit could only be entered as
  // an alias of a billable band, so it coded an E/M at sign-off.
  it("codes nothing for a non-billable visit, ACP minutes included, and calls that conclusive", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "non_billable",
      totalMinutes: 75,
      acpMinutes: 30,
      isTelehealth: true,
    });
    expect(r.base).toEqual([]);
    expect(r.prolongedAddOns).toEqual([]);
    expect(r.acpAddOns).toEqual([]);
    expect(r.modifiers).toEqual([]);
    expect(r.inconclusive).toBe(false);
    expect(r.nonBillable).toBe(true);
  });

  it("CONTROL — the same minutes on an established visit still code, and are billable", () => {
    // 75 minutes, 30 of them ACP: 45 of E/M time is 99349.
    const r = suggestCodes({ ...baseInput, totalMinutes: 75, acpMinutes: 30 });
    expect(r.base[0]?.code).toBe("99349");
    expect(r.acpAddOns[0]?.code).toBe("99497");
    expect(r.nonBillable).toBe(false);
  });

  it("pins inpatient_consult as inconclusive, so adding its ladder has to be deliberate", () => {
    const r = suggestCodes({ ...baseInput, visitType: "inpatient_consult", totalMinutes: 45 });
    expect(r.base).toEqual([]);
    expect(r.inconclusive).toBe(true);
    expect(r.nonBillable).toBe(false);
  });
});

/**
 * The payer's own prolonged-service code (0108). The payer category alone gave
 * every non-Medicare payer 99417, so a patient on an Ohio Medicaid managed-care
 * plan that takes G0318 was never offered it. A payer record that names a code
 * now decides; one that names none leaves the category to decide, which the
 * tests above pin.
 */
describe("suggestCodes — the payer's own prolonged-service code (0108)", () => {
  it("offers G0318 to a non-Medicare payer that takes it, counted from the CMS total time", () => {
    // 120 minutes on 99350: 25 past CMS's 95-minute total, one full 15.
    const r = suggestCodes({
      ...baseInput, totalMinutes: 120, payerCategory: "non_medicare", prolongedServiceCode: "G0318",
    });
    expect(r.prolongedAddOns.map((a) => [a.code, a.units])).toEqual([["G0318", 1]]);
    expect(r.prolongedAddOns[0]!.reason).toContain("The prolonged home-visit add-on this payer takes");
    expect(r.prolongedAddOns[0]!.reason).not.toContain("Medicare");
  });

  it("caps it at G0318's own limit, as for Medicare", () => {
    const r = suggestCodes({
      ...baseInput, totalMinutes: 95 + 15 * 6, payerCategory: "non_medicare", prolongedServiceCode: "G0318",
    });
    expect(r.prolongedAddOns[0]?.units).toBe(4);
  });

  it("offers 99417 to a Medicare-category payer whose record says it takes 99417", () => {
    // 120 minutes on 99350: 60 past the 60-minute CPT time, four full 15s.
    const r = suggestCodes({
      ...baseInput, totalMinutes: 120, payerCategory: "medicare", prolongedServiceCode: "99417",
    });
    expect(r.prolongedAddOns.map((a) => [a.code, a.units])).toEqual([["99417", 4]]);
    expect(r.prolongedAddOns[0]!.reason).toContain("The prolonged-service add-on this payer takes");
  });

  it("CONTROL: with no code on the payer's record the category decides, word for word as before", () => {
    const medicare = suggestCodes({ ...baseInput, totalMinutes: 120, payerCategory: "medicare" });
    const other = suggestCodes({ ...baseInput, totalMinutes: 120, payerCategory: "non_medicare" });
    expect(medicare.prolongedAddOns.map((a) => [a.code, a.units])).toEqual([["G0318", 1]]);
    expect(medicare.prolongedAddOns[0]!.reason).toContain("Medicare prolonged home-visit add-on");
    expect(other.prolongedAddOns.map((a) => [a.code, a.units])).toEqual([["99417", 4]]);
    expect(other.prolongedAddOns[0]!.reason).toContain("Non-Medicare prolonged-service add-on");
  });

  it("still counts E/M time only: ACP minutes billed as ACP are taken out first", () => {
    // 170 minutes with 60 of ACP: 110 E/M minutes, one G0318 unit, not four.
    const r = suggestCodes({
      ...baseInput, totalMinutes: 170, acpMinutes: 60, payerCategory: "non_medicare", prolongedServiceCode: "G0318",
    });
    expect(r.prolongedAddOns.map((a) => [a.code, a.units])).toEqual([["G0318", 1]]);
  });
});
