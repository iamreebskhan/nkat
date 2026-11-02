/**
 * The KPI report's definitions (Level-1 doc:80-109; the practice's Trend Report).
 * Pure: rows in, the table and its CSV out.
 */
import { describe, expect, it } from "vitest";

import {
  buildKpiReport,
  censusOn,
  kpiCsv,
  kpiMonthLabel,
  kpiMonths,
  median,
  weekdaysBetween,
  type KpiInputs,
  type KpiReport,
  type KpiRow,
} from "../kpi-report";

const RANGE = { fromDate: "2026-08-15", toDate: "2026-10-31" };
const TODAY = "2026-10-28";

const empty = (over: Partial<KpiInputs> = {}): KpiInputs => ({
  range: RANGE, today: TODAY, referrals: [], episodes: [], visits: [], discharges: [], events: [], assessments: [],
  scores: [], acuity: [], enrollments: [], careTime: [], careCharges: [], bills: [], denials: [], ...over,
});

/** A row anywhere in the report, by key. */
function find(r: KpiReport, key: string): KpiRow {
  for (const s of r.sections) {
    for (const top of s.rows) {
      if (top.key === key) return top;
      const c = top.children?.find((x) => x.key === key);
      if (c) return c;
    }
  }
  throw new Error(`no row ${key}`);
}
/** [Aug, Sep, Oct, window] */
const values = (r: KpiReport, key: string) => [...find(r, key).months, find(r, key).total];

describe("months and days", () => {
  it("covers every month the window touches, the ends clipped to it", () => {
    expect(kpiMonths(RANGE)).toEqual([
      { key: "2026-08", from: "2026-08-15", to: "2026-08-31" },
      { key: "2026-09", from: "2026-09-01", to: "2026-09-30" },
      { key: "2026-10", from: "2026-10-01", to: "2026-10-31" },
    ]);
    expect(kpiMonths({ fromDate: "2025-12-01", toDate: "2026-01-31" }).map((m) => m.key)).toEqual(["2025-12", "2026-01"]);
    expect(kpiMonthLabel({ key: "2026-09", from: "2026-09-01", to: "2026-09-30" })).toBe("Sep 2026");
    expect(kpiMonthLabel({ key: "2026-08", from: "2026-08-15", to: "2026-08-31" })).toBe("Aug 2026 (15-31)");
    expect(kpiMonthLabel({ key: "2026-07", from: "2026-07-31", to: "2026-07-31" })).toBe("Jul 2026 (31)");
  });

  it("counts weekdays, and takes a median", () => {
    // October 2026 starts on a Thursday: 2 + 4 full weeks.
    expect(weekdaysBetween("2026-10-01", "2026-10-31")).toBe(22);
    expect(weekdaysBetween("2026-10-03", "2026-10-04")).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("referrals, admissions and census", () => {
  const referrals: KpiInputs["referrals"] = [
    { receivedOn: "2026-09-02", stage: "admitted", source: null, ntucOn: null, ntucReason: null, firstVisitOn: "2026-09-09" },
    { receivedOn: "2026-09-10", stage: "admitted", source: null, ntucOn: null, ntucReason: null, firstVisitOn: "2026-10-01" },
    { receivedOn: "2026-09-20", stage: "ntuc", source: null, ntucOn: "2026-10-02", ntucReason: { code: "24", label: "Unable to contact" }, firstVisitOn: null },
    { receivedOn: "2026-09-25", stage: "pre_admission", source: null, ntucOn: null, ntucReason: null, firstVisitOn: null },
    { receivedOn: "2026-10-05", stage: "ntuc", source: null, ntucOn: "2026-10-06", ntucReason: { code: "20a", label: "Declined service" }, firstVisitOn: null },
    // Received before the window, closed in it: counts as NTUC by its day, not as received.
    { receivedOn: "2026-07-30", stage: "ntuc", source: null, ntucOn: "2026-08-20", ntucReason: { code: "24", label: "Unable to contact" }, firstVisitOn: null },
  ];
  const r = buildKpiReport(empty({ referrals }));

  it("counts referrals by the day received, and their outcome so far", () => {
    expect(values(r, "referrals")).toEqual([0, 4, 1, 5]);
    expect(values(r, "referrals:admitted")).toEqual([0, 2, 0, 2]);
    expect(values(r, "referrals:ntuc")).toEqual([0, 1, 1, 2]);
    expect(values(r, "referrals:open")).toEqual([0, 1, 0, 1]);
    // The referral board's conversion: admitted of received; nothing received is no rate, not 0%.
    expect(values(r, "conversion")).toEqual([null, 50, 0, 40]);
  });

  it("closes NTUC by its own day, by reason", () => {
    expect(values(r, "ntuc")).toEqual([1, 0, 2, 3]);
    expect(values(r, "ntuc:24 Unable to contact")).toEqual([1, 0, 1, 2]);
    expect(values(r, "ntuc:20a Declined service")).toEqual([0, 0, 1, 1]);
  });

  it("times referral to first visit, in the month of the visit", () => {
    // 7 days in September; 21 days in October.
    expect(values(r, "referral_to_first_visit")).toEqual([null, 7, 21, 14]);
    expect(values(r, "referral_to_first_visit:n")).toEqual([0, 1, 1, 2]);
  });

  it("takes the census at each month's end, today for a month under way, and the window's at its end", () => {
    const episodes: KpiInputs["episodes"] = [
      { patientId: "a", from: "2026-07-01", to: null },
      // Discharged 31 Aug: not under care at the end of that day.
      { patientId: "b", from: "2026-08-01", to: "2026-08-31" },
      // Discharged and readmitted: one patient, counted once.
      { patientId: "c", from: "2026-08-20", to: "2026-09-10" },
      { patientId: "c", from: "2026-09-12", to: null },
      // Admitted after today's date: not yet under care today.
      { patientId: "d", from: "2026-10-30", to: null },
    ];
    const c = buildKpiReport(empty({ episodes }));
    expect(values(c, "census")).toEqual([2, 2, 2, 2]);
    expect(censusOn(episodes, "2026-08-30")).toBe(3);
    // CONTROL: the day before the readmission, c is out.
    expect(censusOn(episodes, "2026-09-11")).toBe(1);
    expect(values(c, "admissions")).toEqual([1, 1, 1, 3]);
  });
});

describe("visits", () => {
  const v = (patientId: string, day: string, codingBasis: string | null, cptCodes: string[] = [], clinicianId = "h") => ({
    patientId, clinicianId, clinicianName: clinicianId === "h" ? "Helen Okafor" : "Priya Raman", day, codingBasis, cptCodes,
  });
  const r = buildKpiReport(
    empty({
      visits: [
        v("a", "2026-09-01", "new_patient_home", ["99345"]),
        v("a", "2026-09-15", "established_patient_home", ["99349", "99497"]),
        v("b", "2026-09-16", "advance_care_planning", ["99497"], "p"),
        v("b", "2026-10-02", "non_billable"),
        v("c", "2026-10-26", null, [], "p"),
      ],
    }),
  );

  it("counts visits made, by kind, and the Trend Report's new plus follow-up", () => {
    expect(values(r, "visits")).toEqual([0, 3, 2, 5]);
    expect(find(r, "visits").children!.map((c) => c.label)).toEqual([
      "New patient", "Follow-up", "Advance care planning", "Not billed", "Other",
    ]);
    expect(values(r, "visits_new_followup")).toEqual([0, 2, 0, 2]);
    expect(values(r, "visits_acp")).toEqual([0, 2, 0, 2]);
  });

  it("works out patients seen, visits per patient, and visits per weekday to today", () => {
    expect(values(r, "patients_seen")).toEqual([0, 2, 2, 3]);
    expect(values(r, "visit_frequency")).toEqual([null, 1.5, 1, 1.67]);
    // October to the 28th: 20 weekdays; September 22.
    expect(values(r, "visits_per_day")).toEqual([0, 0.14, 0.1, round2(5 / weekdaysBetween("2026-08-17", "2026-10-28"))]);
    expect(values(r, "visits:clinician:h")).toEqual([0, 2, 1, 3]);
  });
});

const round2 = (x: number) => Math.round(x * 100) / 100;

describe("care between visits", () => {
  it("counts enrolment in force, minutes by day worked, and months charged, by program", () => {
    const r = buildKpiReport(
      empty({
        enrollments: [
          { patientId: "a", program: "ccm", enrolledOn: "2026-10-20", endedOn: null },
          { patientId: "b", program: "pcm", enrolledOn: "2026-06-01", endedOn: "2026-09-03" },
        ],
        careTime: [
          { program: "ccm", serviceOn: "2026-10-21", minutes: 15 },
          { program: "ccm", serviceOn: "2026-10-27", minutes: 20 },
          { program: "pcm", serviceOn: "2026-08-20", minutes: 30 },
        ],
        careCharges: [{ program: "ccm", month: "2026-10" }, { program: "pcm", month: "2026-07" }],
      }),
    );
    expect(values(r, "cm_enrolled")).toEqual([1, 1, 1, 2]);
    expect(values(r, "cm_enrolled:ccm")).toEqual([0, 0, 1, 1]);
    expect(values(r, "cm_minutes")).toEqual([30, 0, 35, 65]);
    // July's charge is outside the window.
    expect(values(r, "cm_months_billed")).toEqual([0, 0, 1, 1]);
  });
});

describe("symptoms and acuity", () => {
  const s = (patientId: string, day: string, pain: number | null, dyspnea: number | null = null) => ({
    patientId, day, at: `${day}T15:00:00.000Z`, pain, dyspnea, nausea: null,
  });

  it("averages each patient's last score in the month, and says who is severe or better than at first", () => {
    const r = buildKpiReport(
      empty({
        scores: [
          s("a", "2026-07-01", 8), // the first score on record, before the window
          s("a", "2026-09-05", 6),
          s("a", "2026-09-20", 4),
          s("b", "2026-09-10", 9, 5),
          s("b", "2026-10-01", 9),
        ],
      }),
    );
    // September: a's last is 4, b's 9 → 6.5. October: b's 9.
    expect(values(r, "symptom:pain")).toEqual([null, 6.5, 9, 6.5]);
    expect(values(r, "symptom:pain:n")).toEqual([0, 2, 1, 2]);
    expect(values(r, "symptom:pain:severe")).toEqual([null, 50, 100, 50]);
    // a is better than at first (4 < 8); b's first score is in September itself:
    // compared in October (9 vs 9, not better), not in September.
    expect(values(r, "symptom:pain:improved")).toEqual([null, 100, 0, 50]);
    expect(values(r, "symptom:dyspnea")).toEqual([null, 5, null, 5]);
  });

  it("gives the acuity of the patients under care at each month's end, as last recorded by then", () => {
    const r = buildKpiReport(
      empty({
        episodes: [{ patientId: "a", from: "2026-08-01", to: null }, { patientId: "b", from: "2026-09-01", to: null }],
        acuity: [
          { patientId: "a", day: "2026-08-01", at: "2026-08-01T12:00:00Z", acuity: "medium" },
          { patientId: "a", day: "2026-10-10", at: "2026-10-10T12:00:00Z", acuity: "critical" },
        ],
      }),
    );
    expect(values(r, "acuity")).toEqual([0, 0, 50, 50]);
    expect(values(r, "acuity:medium")).toEqual([1, 1, 0, 0]);
    expect(values(r, "acuity:none")).toEqual([0, 1, 1, 1]);
  });
});

describe("hospital use and events", () => {
  it("counts by the day of the event, and tags readmissions as the chart does", () => {
    const e = (id: string, kind: string, occurredOn: string, endedOn: string | null = null, injury: boolean | null = null) => ({
      id, patientId: "a", kind, occurredOn, endedOn, injury,
    });
    const r = buildKpiReport(
      empty({
        events: [
          e("1", "hospital_admission", "2026-07-25", "2026-08-01"), // before the window: only the tag reads it
          e("2", "hospital_admission", "2026-08-20", "2026-08-25"),
          e("3", "hospital_admission", "2026-10-10"),
          e("4", "fall", "2026-09-03", null, true),
          e("5", "fall", "2026-09-04", null, false),
          e("6", "ed_visit", "2026-10-02"),
        ],
      }),
    );
    expect(values(r, "admissions_hospital")).toEqual([1, 0, 1, 2]);
    // 2 began 19 days after 1 ended; 3, 46 days after 2.
    expect(values(r, "readmissions")).toEqual([1, 0, 0, 1]);
    expect(values(r, "falls")).toEqual([0, 2, 0, 2]);
    expect(values(r, "falls:injury")).toEqual([0, 1, 0, 1]);
    expect(values(r, "ed_visits")).toEqual([0, 0, 1, 1]);
  });
});

describe("hospice and discharges", () => {
  const d = (dischargedOn: string, code: string | null, category = "other", hospice: [string | null, string | null] = [null, null]) => ({
    dischargedOn,
    reason: code ? { code, label: `Reason ${code}`, category } : null,
    hospiceAdmittedOn: hospice[0],
    hospiceEndedOn: hospice[1],
  });
  const r = buildKpiReport(
    empty({
      discharges: [
        d("2026-09-02", "01", "hospice_partner", ["2026-09-03", "2026-09-20"]),
        d("2026-09-15", "02", "hospice_other", ["2026-09-15", "2026-10-15"]),
        d("2026-10-04", "01b", "hospice_partner"),
        d("2026-10-09", "08", "death"),
        d("2026-08-28", null),
      ],
      assessments: [{ patientId: "a", assessedOn: "2026-09-01", eligible: true }, { patientId: "b", assessedOn: "2026-09-02", eligible: false }],
    }),
  );

  it("splits transitions to hospice between the partner and others", () => {
    expect(values(r, "transitions")).toEqual([0, 2, 1, 3]);
    expect(values(r, "transitions:partner")).toEqual([0, 1, 1, 2]);
    expect(values(r, "transitions_partner_share")).toEqual([null, 50, 100, 66.7]);
  });

  it("counts hospice admissions by the hospice's day, and the stay's length when it ends", () => {
    expect(values(r, "hospice_admissions")).toEqual([0, 2, 0, 2]);
    // 17 days, ended in September; 30 days, ended in October.
    expect(values(r, "hospice_los")).toEqual([null, 17, 30, 23.5]);
    expect(values(r, "hospice_los:n")).toEqual([0, 1, 1, 2]);
  });

  it("counts deaths and every discharge by reason, one with none included", () => {
    expect(values(r, "deaths")).toEqual([0, 0, 1, 1]);
    expect(values(r, "discharges")).toEqual([1, 2, 2, 5]);
    expect(find(r, "discharges").children!.map((c) => c.label)).toEqual([
      "01 Reason 01", "01b Reason 01b", "02 Reason 02", "08 Reason 08", "No reason recorded",
    ]);
    expect(values(r, "hospice_assessed")).toEqual([0, 2, 0, 2]);
    expect(values(r, "hospice_assessed:yes")).toEqual([0, 1, 0, 1]);
  });
});

describe("billing and revenue", () => {
  const b = (dos: string, status: string, billedCents: number, paidCents: number | null, patientId = "a", submittedOn: string | null = null) => ({
    patientId, clinicianId: patientId === "a" ? "h" : "p", clinicianName: patientId === "a" ? "Helen Okafor" : "Priya Raman",
    status, dos, billedCents, paidCents, submittedOn,
  });
  const r = buildKpiReport(
    empty({
      bills: [
        b("2026-09-03", "paid", 10000, 8000, "a", "2026-09-05"),
        b("2026-09-10", "submitted", 20000, null, "b", "2026-09-12"),
        b("2026-09-11", "draft", 99900, null), // CONTROL: never raised
        b("2026-09-12", "voided", 55500, null, "b", "2026-09-13"), // CONTROL: cancelled, though submitted once
        b("2026-10-02", "denied", 5000, 0, "a", "2026-10-03"),
      ],
      denials: [{ payerName: "CareSource Ohio", dos: "2026-10-02", deniedCents: 5000 }],
    }),
  );

  it("bills and collects by date of service, drafts and voided bills left out", () => {
    expect(values(r, "billed")).toEqual([0, 30000, 5000, 35000]);
    expect(values(r, "collected")).toEqual([0, 8000, 0, 8000]);
    expect(values(r, "collection_rate")).toEqual([null, 26.7, 0, 22.9]);
  });

  it("counts claims by the day submitted, voided ones too: they went out", () => {
    expect(values(r, "claims_submitted")).toEqual([0, 3, 1, 4]);
    expect(values(r, "claims_submitted:billed")).toEqual([0, 85500, 5000, 90500]);
  });

  it("rates denials on the claims' own dates, by payer, and per patient and clinician", () => {
    expect(values(r, "denied")).toEqual([0, 0, 5000, 5000]);
    expect(values(r, "denied:CareSource Ohio")).toEqual([0, 0, 5000, 5000]);
    expect(values(r, "denial_rate")).toEqual([null, 0, 100, 14.3]);
    expect(values(r, "billed_per_patient")).toEqual([null, 15000, 5000, 17500]);
    expect(values(r, "billed:clinician:h")).toEqual([0, 10000, 5000, 15000]);
    expect(values(r, "collected:clinician:p")).toEqual([0, 0, 0, 0]);
  });
});

describe("the CSV", () => {
  it("writes each measure and its parts with its definition, money in dollars, CRLF", () => {
    const r = buildKpiReport(
      empty({
        bills: [{ patientId: "a", clinicianId: "h", clinicianName: "=HYPERLINK(\"x\")", status: "paid", dos: "2026-09-03", billedCents: 12345, paidCents: 12345, submittedOn: null }],
      }),
    );
    const lines = kpiCsv(r).split("\r\n");
    expect(lines[0]).toBe(
      "section,measure,part of,unit,source,definition,Aug 2026 (15-31),Sep 2026,Oct 2026,2026-08-15 to 2026-10-31,entered by hand",
    );
    const billed = lines.find((l) => l.startsWith("Billing and revenue,Charges billed,"))!;
    expect(billed.endsWith(",0.00,123.45,0.00,123.45,")).toBe(true);
    expect(billed).toContain(",dollars,doc:102,");
    // A part names what it is part of; a name that reads as a formula does not run.
    const part = lines.find((l) => l.includes("Billed, by rendering clinician") && l.includes("HYPERLINK"))!;
    expect(part.startsWith(`Billing and revenue,"'=HYPERLINK(""x"")","Billed, by rendering clinician",dollars,`)).toBe(true);
    expect(lines.at(-1)).toBe("");
    // A rate with nothing to divide by is an empty cell, not 0.
    const rate = lines.find((l) => l.startsWith("Billing and revenue,Collection rate,"))!;
    expect(rate.endsWith(",,100.0,,100.0,")).toBe(true);
  });
});
