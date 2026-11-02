/**
 * What a month of PCM/CCM time bills (0117; doc:53, :69, :101): thresholds,
 * add-on increments and their cap, whose time counts toward which set, the
 * date of service, and the signed record's text. Pure.
 */
import { describe, expect, it } from "vitest";

import {
  RaiseChargeSchema,
  chargeFor,
  chargeSummaryText,
  monthBounds,
  monthLabel,
  monthProgress,
  performerKindFor,
  shiftMonth,
  type TimeEntry,
} from "../care-management";

const NP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_NP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LPN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const staff = (serviceOn: string, minutes: number): TimeEntry => ({ serviceOn, minutes, kind: "clinical_staff", performedBy: LPN });
const own = (serviceOn: string, minutes: number, by = NP): TimeEntry => ({ serviceOn, minutes, kind: "qhp", performedBy: by });

describe("whose time it is", () => {
  it("reads a practitioner from the credentials that bill, and clinical staff from the rest", () => {
    for (const c of ["NP", "MD", "DO", "PA", "CNS"]) expect(performerKindFor(c), c).toBe("qhp");
    for (const c of ["RN", "LPN", "LCSW", "OTHER"]) expect(performerKindFor(c), c).toBe("clinical_staff");
  });
});

describe("CCM", () => {
  it("bills 99490 once 20 minutes are reached, dated the day they were", () => {
    const p = monthProgress("ccm", [staff("2026-10-03", 15), staff("2026-10-09", 10)], null);
    expect(p.staff).toMatchObject({ base: "99490", minutes: 25, reached: ["2026-10-09"] });
    expect(chargeFor(p.staff)).toEqual({ codes: ["99490"], units: {}, addOnUnits: 0, dateOfService: "2026-10-09" });
  });

  it("CONTROL: 19 minutes bill nothing", () => {
    const p = monthProgress("ccm", [staff("2026-10-03", 19)], null);
    expect(p.staff.reached).toEqual([]);
    expect(chargeFor(p.staff)).toBeNull();
  });

  it("adds 99439 per whole 20 minutes, at most two, the date of service moving to the day the last billed unit was reached", () => {
    const p = monthProgress(
      "ccm",
      [staff("2026-10-02", 20), staff("2026-10-10", 19), staff("2026-10-12", 1), staff("2026-10-20", 30), staff("2026-10-25", 40)],
      null,
    );
    // 20 → base on the 2nd; 40 → unit 1 on the 12th; 60 → unit 2 on the 20th; the cap stops there.
    expect(p.staff.reached).toEqual(["2026-10-02", "2026-10-12", "2026-10-20"]);
    expect(chargeFor(p.staff)).toEqual({ codes: ["99490", "99439"], units: { "99439": 2 }, addOnUnits: 2, dateOfService: "2026-10-20" });
    // One unit is stored as no key (code-units normalizeUnits); fewer may be billed, never more.
    expect(chargeFor(p.staff, 1)).toEqual({ codes: ["99490", "99439"], units: {}, addOnUnits: 1, dateOfService: "2026-10-12" });
    expect(chargeFor(p.staff, 0)).toEqual({ codes: ["99490"], units: {}, addOnUnits: 0, dateOfService: "2026-10-02" });
    expect(chargeFor(p.staff, 5)!.addOnUnits).toBe(2);
  });

  it("counts a practitioner's own time toward the clinical staff set, never staff time toward the practitioner's", () => {
    const p = monthProgress("ccm", [staff("2026-10-02", 25), own("2026-10-05", 20)], NP);
    expect(p.staff.minutes).toBe(45);
    expect(p.qhp).toMatchObject({ base: "99491", minutes: 20, reached: [] });
  });

  it("bills 99491 on 30 minutes of the billing practitioner's own time, with no add-on", () => {
    const p = monthProgress("ccm", [own("2026-10-05", 20), own("2026-10-07", 45)], NP);
    expect(p.qhp!.reached).toEqual(["2026-10-07"]);
    expect(chargeFor(p.qhp!)).toEqual({ codes: ["99491"], units: {}, addOnUnits: 0, dateOfService: "2026-10-07" });
  });

  it("CONTROL: a colleague's minutes are not the biller's own time", () => {
    const p = monthProgress("ccm", [own("2026-10-05", 20), own("2026-10-06", 20, OTHER_NP)], NP);
    expect(p.qhp!.minutes).toBe(20);
    expect(p.qhp!.reached).toEqual([]);
    // …though both count as clinical staff time.
    expect(p.staff.minutes).toBe(40);
    // And without a practitioner named, there is no practitioner's set at all.
    expect(monthProgress("ccm", [own("2026-10-05", 40)], null).qhp).toBeNull();
  });
});

describe("PCM", () => {
  it("bills 99426 at 30 minutes and 99427 per whole 30 after, uncapped", () => {
    const p = monthProgress("pcm", [staff("2026-10-01", 30), staff("2026-10-08", 59), staff("2026-10-15", 31)], null);
    // 30 on the 1st; 60 on the 8th (89 by then, one short of 90); 90 and 120 both on the 15th.
    expect(p.staff.reached).toEqual(["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-15"]);
    expect(chargeFor(p.staff)).toEqual({ codes: ["99426", "99427"], units: { "99427": 3 }, addOnUnits: 3, dateOfService: "2026-10-15" });
    expect(chargeFor(p.staff, 1)!.dateOfService).toBe("2026-10-08");
  });

  it("bills 99424 and 99425 on the practitioner's own time", () => {
    const p = monthProgress("pcm", [own("2026-10-01", 61)], NP);
    expect(chargeFor(p.qhp!)).toEqual({ codes: ["99424", "99425"], units: {}, addOnUnits: 1, dateOfService: "2026-10-01" });
  });

  it("orders the log by day whatever order it is given in", () => {
    const p = monthProgress("pcm", [staff("2026-10-20", 10), staff("2026-10-02", 25)], null);
    expect(p.staff.reached).toEqual(["2026-10-20"]);
  });
});

describe("the charge's record and its request", () => {
  it("says what was billed, on whose time, how much, and the consent it rests on, never a note", () => {
    const text = chargeSummaryText({
      program: "ccm", month: "2026-10", basis: "staff", codes: ["99490", "99439"], units: { "99439": 2 },
      minutes: { counted: 65, staff: 45, qhp: 20 }, entries: 4, firstDay: "2026-10-02", lastDay: "2026-10-20",
      dateOfService: "2026-10-20", enrolledOn: "2026-10-01", consentOn: "2026-09-30", consentMethod: "verbal",
      raisedBy: "Helen Okafor, MD",
    });
    expect(text.split("\n")).toEqual([
      "CCM, October 2026: billed from the time log.",
      "Codes: 99490, 99439 ×2, on clinical staff time.",
      "Time counted: 65 minutes (45 clinical staff, 20 practitioner), 4 entries from 2026-10-02 to 2026-10-20.",
      "Date of service: 2026-10-20, the day the billed time was reached.",
      "Enrolled 2026-10-01, after verbal consent on 2026-09-30.",
      "Raised by Helen Okafor, MD.",
    ]);
  });

  it("refuses a month that is not one, no diagnosis, a diagnosis twice and a place of service other than 11 or 12", () => {
    const ok = {
      enrollmentId: "c1000000-0000-4000-8000-000000000001", month: "2026-10", basis: "staff", placeOfService: "11",
      diagnoses: ["C34.12"],
    };
    expect(RaiseChargeSchema.safeParse(ok).success).toBe(true);
    expect(RaiseChargeSchema.safeParse({ ...ok, month: "2026-13" }).success).toBe(false);
    expect(RaiseChargeSchema.safeParse({ ...ok, diagnoses: [] }).success).toBe(false);
    expect(RaiseChargeSchema.safeParse({ ...ok, diagnoses: ["I50.9", "i50.9"] }).success).toBe(false);
    expect(RaiseChargeSchema.safeParse({ ...ok, placeOfService: "10" }).success).toBe(false);
  });

  it("knows the months' days, names and neighbours", () => {
    expect(monthBounds("2028-02")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
    expect(monthBounds("2026-10")).toEqual({ first: "2026-10-01", last: "2026-10-31" });
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
