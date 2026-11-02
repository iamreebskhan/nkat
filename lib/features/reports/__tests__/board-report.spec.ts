/**
 * The board report: one structure from the KPI reports, three files from it.
 * The workbook and the deck are read back; they are opened in Excel and
 * PowerPoint by hand on localhost.
 */
import { describe, expect, it } from "vitest";

import { unzip, xlsxRows } from "@/lib/features/billing/ncci-files";

import { boardDeck, boardFileName, boardHtml, boardWorkbook, chartTicks } from "../board-files";
import { boardMonthLabel, boardShortMonth, boardWindows, buildBoardReport, BoardFileSchema, type BoardInputs } from "../board-report";
import { applyKpiHistory, type KpiEntered, type KpiReason } from "../kpi-history";
import { buildKpiReport, type KpiInputs, type KpiReport } from "../kpi-report";
import { buildYearOverYear } from "../kpi-year-over-year";
import { buildPptx } from "../pptx-writer";

const report = (range: { fromDate: string; toDate: string }, over: Partial<KpiInputs> = {}, today = "2026-10-30"): KpiReport =>
  buildKpiReport({
    range, today, referrals: [], episodes: [], visits: [], discharges: [], events: [], assessments: [],
    scores: [], acuity: [], enrollments: [], careTime: [], careCharges: [], bills: [], denials: [], ...over,
  });

const e = (month: string, measure: string, value: number): KpiEntered => ({ month, measure, value });
const REASONS: KpiReason[] = [
  { kind: "discharge", code: "01", label: "Hospice - partner", category: "hospice_partner" },
  { kind: "discharge", code: "02", label: "Hospice - other", category: "hospice_other" },
  { kind: "discharge", code: "08", label: "Death on palliative", category: "death" },
  { kind: "ntuc", code: "24", label: "Unable to contact", category: "lost_contact" },
];

function inputs(entered: KpiEntered[], over: Partial<BoardInputs> = {}, data: Partial<KpiInputs> = {}): BoardInputs {
  const w = boardWindows("2026-06");
  const on = (range: { fromDate: string; toDate: string }) => applyKpiHistory(report(range, data), entered, REASONS);
  const yearReport = on(w.year);
  return {
    orgName: "Test & Sons <Palliative>",
    month: "2026-06",
    today: "2026-10-30",
    span: on(w.span),
    twelve: on(w.twelve),
    yearReport,
    year: buildYearOverYear(yearReport, on({ fromDate: "2025-01-01", toDate: "2025-06-30" })),
    plan: [e("2026-01", "plan:billing", 18000), e("2026-02", "plan:billing", 24000), e("2026-01", "plan:census", 100), e("2026-01", "plan:admissions", 16)],
    reasons: REASONS,
    onBothLists: 0,
    celebrations: [],
    ...over,
  };
}

const ALL_MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
const everyMonth = (measure: string, value: number) => ALL_MONTHS.map((m) => e(m, measure, value));
const filled = [...everyMonth("referrals", 30), ...everyMonth("admitted", 20), ...everyMonth("census", 100), ...everyMonth("billed", 20000), ...everyMonth("visits_new", 20), ...everyMonth("visits_followup", 100)];

describe("the windows", () => {
  it("runs the charts from January two years back and the year from January", () => {
    expect(boardWindows("2026-06")).toEqual({
      span: { fromDate: "2024-01-01", toDate: "2026-06-30" },
      year: { fromDate: "2026-01-01", toDate: "2026-06-30" },
      twelve: { fromDate: "2025-07-01", toDate: "2026-06-30" },
    });
  });

  it("takes the first of the month and the real month end, not a month of thirty days", () => {
    expect(boardWindows("2026-08").span.toDate).toBe("2026-08-31");
    expect(boardWindows("2026-12").twelve.fromDate).toBe("2026-01-01");
    expect(boardWindows("2028-02").year.toDate).toBe("2028-02-29");
  });

  it("names months as the Trend Report does", () => {
    expect(boardShortMonth("2026-06")).toBe("Jun-26");
    expect(boardMonthLabel("2026-06")).toBe("June 2026");
  });
});

describe("the report", () => {
  const b = buildBoardReport(inputs(filled));

  it("gives the chart a value for every month it names, from the first with a figure to the month", () => {
    expect(b.billing.categories).toEqual(["Jan-26", "Feb-26", "Mar-26", "Apr-26", "May-26", "Jun-26"]);
    for (const s of [...b.billing.bars, ...b.billing.lines, ...b.census.bars]) expect(s.values).toHaveLength(6);
    const longer = buildBoardReport(inputs([...filled, e("2024-03", "billed", 500)]));
    expect(longer.billing.categories).toHaveLength(28);
    expect(longer.billing.categories[0]).toBe("Mar-24");
    expect(longer.billing.bars[0]!.values).toHaveLength(28);
    expect(longer.billing.lines[0]!.values).toHaveLength(28);
  });

  it("draws the plan from when it was set, carried forward, in dollars", () => {
    const plan = buildBoardReport(inputs([...filled, e("2025-12", "billed", 500)])).billing.lines[0]!.values;
    expect(plan[0]).toBeNull(); // Dec-25
    expect(plan[1]).toBe(18000); // Jan-26
    expect(plan.at(-1)).toBe(24000);
    expect(b.billing.bars[0]!.values.at(-1)).toBe(20000);
  });

  it("leaves the plan line off when none is entered", () => {
    expect(buildBoardReport(inputs(filled, { plan: [] })).billing.lines).toEqual([]);
  });

  it("lists every reason code the practice has, with a total", () => {
    expect(b.discharges.rows.map((r) => r.label)).toEqual(["01 Hospice - partner", "02 Hospice - other", "08 Death on palliative", "Total"]);
    expect(b.ntuc.rows.map((r) => r.label)).toEqual(["24 Unable to contact", "Total"]);
    expect(b.discharges.columns).toEqual(["Jan-26", "Feb-26", "Mar-26", "Apr-26", "May-26", "Jun-26"]);
  });

  it("carries the year's visits into the highlights", () => {
    expect(b.highlights).toEqual(["720 YTD patient visits"]);
  });

  it("orders the sources by volume and leaves out the unrecorded", () => {
    const referral = (receivedOn: string, source: string | null) => ({ receivedOn, stage: "admitted", source, ntucOn: null, ntucReason: null, firstVisitOn: null });
    const c = buildBoardReport(inputs(filled.filter((x) => x.measure !== "referrals"), {}, { referrals: [referral("2026-03-01", "B"), referral("2026-03-02", "A"), referral("2026-03-03", "A"), referral("2026-03-04", null)] }));
    expect(c.sources).toEqual([{ label: "A", referrals: 2, admitted: 2 }, { label: "B", referrals: 1, admitted: 1 }]);
  });
});

describe("what to check", () => {
  const texts = (i: BoardInputs) => buildBoardReport(i).exceptions.map((x) => x.text);

  it("CONTROL: nothing to say about a whole, reconciled year with a plan", () => {
    expect(texts(inputs(filled))).toEqual([]);
  });

  it("says a month is still under way", () => {
    expect(texts(inputs(filled, { today: "2026-06-20" }))).toContain("June 2026 is still under way: its figures run to 2026-06-20.");
  });

  it("names a month with nothing in it", () => {
    const missing = filled.filter((x) => x.month !== "2026-04");
    expect(texts(inputs(missing))).toContain("Nothing is recorded for Apr 2026: no referrals, census, visits or billing.");
  });

  it("names discharges and NTUC with no reason recorded", () => {
    const discharge = { dischargedOn: "2026-06-10", reason: null, hospiceAdmittedOn: null, hospiceEndedOn: null };
    const referral = { receivedOn: "2026-05-01", stage: "ntuc", source: null, ntucOn: "2026-06-11", ntucReason: null, firstVisitOn: null };
    const t = texts(inputs(filled, {}, { discharges: [discharge], referrals: [referral] }));
    expect(t).toContain("Jun 2026: 1 discharge with no reason recorded, in the total but on no reason's row.");
    expect(t).toContain("Jun 2026: 1 referral not taken under care with no reason recorded, in the total but on no reason's row.");
  });

  it("says where the same count disagrees between the two sheets", () => {
    const t = texts(inputs([...filled, e("2026-02", "to_partner", 4), e("2026-02", "discharge:01", 6), e("2026-03", "deaths", 1), e("2026-03", "discharge:08", 1)]));
    expect(t).toContain("Feb 2026: 4 transitions to the partner hospice on the plan sheet, 6 by discharge reason.");
    expect(t.some((x) => x.includes("deaths on the plan sheet"))).toBe(false);
  });

  it("says when more were admitted than referred", () => {
    expect(texts(inputs([...filled.filter((x) => !(x.month === "2026-05" && x.measure === "admitted")), e("2026-05", "admitted", 31)]))).toContain("May 2026: 31 admitted of 30 referrals.");
  });

  it("says when visits of other kinds are left out of the month's total", () => {
    const visit = { patientId: "p", clinicianId: "c", clinicianName: "C", day: "2026-06-02", codingBasis: "non_billable", cptCodes: [] };
    expect(texts(inputs(filled, {}, { visits: [visit] }))).toContain("June 2026: 1 visit of other kinds (consults, not billed) is not in the 120 new patient and follow-up visits.");
  });

  it("says when a patient is on both lists, and what plan is missing", () => {
    expect(texts(inputs(filled, { onBothLists: 2 }))).toContain("June 2026: 2 patients are on both the not taken under care and the discharges lists.");
    expect(texts(inputs(filled, { plan: [] }))).toContain("No billing plan is entered, so the report has no line to measure it against. Add it on Monthly history.");
  });

  it("names a figure that differs from Pallio's, in its unit", () => {
    const bill = { patientId: "p", clinicianId: null, clinicianName: null, status: "paid", dos: "2026-06-05", billedCents: 10000, paidCents: 0, submittedOn: null };
    expect(texts(inputs(filled, {}, { bills: [bill] }))).toContain("June 2026: Billing was entered as $20,000; Pallio counts $100. The entered figure is used.");
  });
});

describe("the files", () => {
  const b = buildBoardReport(inputs(filled, { celebrations: ["Team <trained> & ready"] }));
  const part = async (bytes: Uint8Array, name: string) => {
    const f = (await unzip(bytes)).find((x) => x.name === name);
    if (!f) throw new Error(`no ${name}`);
    return new TextDecoder().decode(f.data);
  };

  it("writes the workbook's four sheets, plan first", async () => {
    const entries = await unzip(boardWorkbook(b));
    const wb = new TextDecoder().decode(entries.find((x) => x.name === "xl/workbook.xml")!.data);
    expect([...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Plan vs actual", "Discharges and NTUC", "Year over year", "Exceptions"]);
    const rows = [...xlsxRows(entries)].map((r) => r.join("|"));
    expect(rows.some((r) => r.startsWith("Plan vs actual|Jan-24|"))).toBe(true);
    expect(rows.some((r) => r.startsWith("Goal|") && r.endsWith("|16|16|16|16|16|16"))).toBe(true);
  });

  it("marks the workbook's exceptions, or says there are none", async () => {
    const out = await part(boardWorkbook(b), "xl/worksheets/sheet4.xml");
    expect(out).toContain("Nothing to check.");
    const other = buildBoardReport(inputs(filled, { onBothLists: 1 }));
    expect(await part(boardWorkbook(other), "xl/worksheets/sheet4.xml")).toContain("1 patient is on both");
  });

  it("writes nine slides, with a native chart and its data on the billing slide", async () => {
    const deck = boardDeck(b);
    const entries = await unzip(deck);
    expect(entries.filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x.name))).toHaveLength(9);
    const charts = entries.filter((x) => /^ppt\/charts\/chart\d+\.xml$/.test(x.name));
    expect(charts).toHaveLength(3);
    const billing = new TextDecoder().decode(charts[0]!.data);
    expect(billing).toContain("<c:barChart>");
    expect(billing).toContain("<c:lineChart>");
    // A number format on the axis: not the dates a linked format printed.
    expect(billing).toContain('formatCode="&quot;$&quot;#,##0"');
    expect(billing).toContain("Sheet1!$A$2:$A$7");
    expect(entries.some((x) => x.name === "ppt/embeddings/Microsoft_Excel_Sheet1.xlsx")).toBe(true);
    const slide5 = await part(deck, "ppt/slides/slide5.xml");
    expect(slide5).toContain("% of referrals admitted");
    expect(await part(deck, "ppt/slides/slide1.xml")).toContain("Test &amp; Sons &lt;Palliative&gt;");
    expect(await part(deck, "ppt/slides/slide2.xml")).toContain("Team &lt;trained&gt; &amp; ready");
  });

  it("gives a slide of words where no sources are recorded", async () => {
    const entries = await unzip(boardDeck(b));
    expect(new TextDecoder().decode(entries.find((x) => x.name === "ppt/slides/slide7.xml")!.data)).toContain("No referral sources are recorded");
  });

  it("escapes the HTML the PDF prints, and prints nine pages", () => {
    const html = boardHtml(b);
    expect(html).toContain("Test &amp; Sons &lt;Palliative&gt;");
    expect(html).not.toContain("<Palliative>");
    expect(html.match(/<section/g)).toHaveLength(9);
  });

  it("marks the chart's axis in round steps", () => {
    expect(chartTicks(130)).toEqual([0, 50, 100, 150]);
    expect(chartTicks(24000)).toEqual([0, 10000, 20000, 30000]);
    expect(chartTicks(3)).toEqual([0, 1, 2, 3]);
    expect(chartTicks(0)).toEqual([0, 1]);
  });

  it("names the file for the month", () => {
    expect(boardFileName(b, "pptx")).toBe("pallio-board-report-2026-06.pptx");
  });

  it("refuses a deck of no slides", () => {
    expect(() => buildPptx([])).toThrow();
  });

  it("takes only the three formats, and keeps what is typed short", () => {
    expect(BoardFileSchema.safeParse({ month: "2026-06", format: "docx" }).success).toBe(false);
    expect(BoardFileSchema.safeParse({ month: "2026-06", format: "pdf", celebrations: ["x".repeat(201)] }).success).toBe(false);
    expect(BoardFileSchema.parse({ month: "2026-06", format: "pdf" }).celebrations).toEqual([]);
  });
});
