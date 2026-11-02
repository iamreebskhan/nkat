/**
 * Referral sources, the year-over-year table and the Excel workbook. Pure: the
 * workbook is read back with the same reader the NCCI upload uses.
 */
import { describe, expect, it } from "vitest";

import { unzip, xlsxRows } from "@/lib/features/billing/ncci-files";

import { applyKpiHistory } from "../kpi-history";
import { buildKpiReport, formatKpi, type KpiInputs, type KpiReport, type KpiRow } from "../kpi-report";
import { kpiCell, kpiWorkbook } from "../kpi-workbook";
import { buildYearOverYear, monthsCovered, priorYearRange, yearChange } from "../kpi-year-over-year";
import { buildXlsx, columnName, xmlText } from "../xlsx-writer";
import { crc32, zipStore } from "../zip-store";

const report = (range: { fromDate: string; toDate: string }, over: Partial<KpiInputs> = {}): KpiReport =>
  buildKpiReport({
    range, today: "2026-10-31", referrals: [], episodes: [], visits: [], discharges: [], events: [], assessments: [],
    scores: [], acuity: [], enrollments: [], careTime: [], careCharges: [], bills: [], denials: [], ...over,
  });

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

const referral = (receivedOn: string, stage: string, source: string | null): KpiInputs["referrals"][number] => ({
  receivedOn, stage, source, ntucOn: null, ntucReason: null, firstVisitOn: null,
});

describe("referrals by source", () => {
  const r = report(
    { fromDate: "2026-09-01", toDate: "2026-10-31" },
    {
      referrals: [
        referral("2026-09-02", "admitted", "City Oncology"),
        referral("2026-09-03", "ntuc", "city  oncology "),
        referral("2026-10-03", "admitted", "City Oncology"),
        referral("2026-10-04", "admitted", "Family Medicine"),
        referral("2026-10-05", "pre_admission", null),
        // Before the window: not counted, though the service may read it for its NTUC day.
        referral("2026-08-30", "admitted", "City Oncology"),
      ],
    },
  );

  it("groups a source however it was typed, under its commonest spelling", () => {
    const row = find(r, "source_referrals:city oncology");
    expect(row.label).toBe("City Oncology");
    expect([...row.months, row.total]).toEqual([2, 1, 3]);
  });

  it("puts the busiest first and the ones with no source last", () => {
    expect(find(r, "source_referrals").children!.map((c) => c.label)).toEqual(["City Oncology", "Family Medicine", "Source not recorded"]);
    const row = find(r, "source_referrals");
    expect([...row.months, row.total]).toEqual([2, 3, 5]);
  });

  it("keeps the ones with no source last even when they are the most", () => {
    const many = report(
      { fromDate: "2026-09-01", toDate: "2026-10-31" },
      { referrals: [referral("2026-09-02", "admitted", null), referral("2026-09-03", "ntuc", null), referral("2026-09-04", "admitted", "Zed Clinic")] },
    );
    expect(find(many, "source_referrals").children!.map((c) => c.label)).toEqual(["Zed Clinic", "Source not recorded"]);
  });

  it("gives each source's admitted and conversion, on the referrals received in the month", () => {
    const admitted = find(r, "source_admitted:city oncology");
    expect([...admitted.months, admitted.total]).toEqual([1, 1, 2]);
    const conversion = find(r, "source_conversion:city oncology");
    expect([...conversion.months, conversion.total]).toEqual([50, 100, 66.7]);
    // Nothing from it in September: no rate, not 0%.
    expect(find(r, "source_conversion:family medicine").months).toEqual([null, 100]);
  });

  it("CONTROL: an empty window has the rows and no parts", () => {
    const none = report({ fromDate: "2026-09-01", toDate: "2026-10-31" });
    expect(find(none, "source_referrals").children).toEqual([]);
    expect(find(none, "source_referrals").total).toBe(0);
  });
});

describe("the prior year's days", () => {
  it("is the same days a year before", () => {
    expect(priorYearRange({ fromDate: "2026-01-01", toDate: "2026-06-30" })).toEqual({ fromDate: "2025-01-01", toDate: "2025-06-30" });
    expect(priorYearRange({ fromDate: "2026-03-15", toDate: "2026-10-28" })).toEqual({ fromDate: "2025-03-15", toDate: "2025-10-28" });
  });

  it("keeps the end of February the end of February", () => {
    expect(priorYearRange({ fromDate: "2028-01-01", toDate: "2028-02-29" }).toDate).toBe("2027-02-28");
    expect(priorYearRange({ fromDate: "2029-01-01", toDate: "2029-02-28" }).toDate).toBe("2028-02-29");
  });
});

describe("months covered", () => {
  it("divides six whole months by exactly six, whatever their lengths", () => {
    const m = report({ fromDate: "2026-01-01", toDate: "2026-06-30" }).months;
    expect(monthsCovered(m)).toBe(6);
  });

  it("counts a part of a month by its share of the days", () => {
    const m = report({ fromDate: "2026-09-01", toDate: "2026-10-15" }).months;
    expect(monthsCovered(m)).toBeCloseTo(1 + 15 / 31, 6);
  });
});

describe("the year-over-year table", () => {
  const visit = (day: string, codingBasis: string, cptCodes: string[] = []) => ({ patientId: `p${day}`, clinicianId: "c", clinicianName: "C", day, codingBasis, cptCodes });
  const discharge = (dischargedOn: string, code: string, category: string) => ({ dischargedOn, reason: { code, label: code, category }, hospiceAdmittedOn: null, hospiceEndedOn: null });
  const inputs = (year: number, partner: number, other: number): Partial<KpiInputs> => ({
    referrals: [
      referral(`${year}-01-10`, "admitted", "A"), referral(`${year}-02-10`, "admitted", "A"), referral(`${year}-02-11`, "ntuc", "A"), referral(`${year}-03-10`, "ntuc", "B"),
    ],
    episodes: [{ patientId: "x", from: `${year}-01-01`, to: null }, { patientId: "y", from: `${year}-02-01`, to: null }],
    visits: [visit(`${year}-01-05`, "new_patient_home", ["99497"]), visit(`${year}-02-05`, "established_patient_home"), visit(`${year}-03-05`, "established_patient_home"), visit(`${year}-03-06`, "non_billable")],
    discharges: [
      ...Array.from({ length: partner }, () => discharge(`${year}-02-20`, "01", "hospice_partner")),
      ...Array.from({ length: other }, () => discharge(`${year}-02-21`, "02", "hospice_other")),
      discharge(`${year}-03-20`, "08", "death"),
    ],
  });
  const y = buildYearOverYear(
    report({ fromDate: "2026-01-01", toDate: "2026-03-31" }, inputs(2026, 3, 1)),
    report({ fromDate: "2025-01-01", toDate: "2025-03-31" }, inputs(2025, 1, 1)),
  );
  const line = (key: string) => y.rows.find((r) => r.key === key)!;

  it("has the Trend Report's fourteen rows, in its order", () => {
    expect(y.rows.map((r) => r.label)).toEqual([
      "Palliative census", "Referrals", "Total admissions", "Admissions per month", "% of referrals admitted", "Total NP visits", "NP visits per month",
      "Advance care plans / goals of care", "Advance care plans / goals of care per month", "Discharges to hospice: partner", "Discharges to hospice: other",
      "% to other hospices", "Deaths on palliative care", "Deaths per month",
    ]);
    expect(y.months).toBe(3);
  });

  it("takes the census at the end, and sums the rest", () => {
    expect(line("census").current).toBe(2);
    expect(line("referrals").current).toBe(4);
    expect(line("admissions").current).toBe(2);
    expect(line("visits").current).toBe(3); // new + follow-up, not the visit not billed
    expect(line("acp").current).toBe(1);
  });

  it("derives per-month from the months, and % admitted from the rows", () => {
    expect(line("admissions_per_month").current).toBe(0.7);
    expect(line("visits_per_month").current).toBe(1);
    expect(line("admitted_share").current).toBe(50);
  });

  it("reads % to other as other ÷ (partner + other)", () => {
    expect(line("other_share").prior).toBe(50);
    expect(line("other_share").current).toBe(25);
  });

  it("says the change in points for a percent, as a percent otherwise, and nothing against zero", () => {
    expect(yearChange(line("other_share"))).toBe("−25.0 pts");
    expect(yearChange(line("to_partner"))).toBe("+200.0%");
    expect(yearChange(line("census"))).toBe("0.0%");
    expect(yearChange({ ...line("census"), prior: 0, current: 5 })).toBe("—");
    expect(yearChange({ ...line("census"), prior: 0, current: 0 })).toBe("0%");
    expect(yearChange({ ...line("census"), prior: null })).toBe("—");
  });

  it("CONTROL: a month's part-way figure is shown to one place", () => {
    expect(formatKpi(12.5, "average")).toBe("12.5");
  });
});

describe("the zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips through a real zip reader", async () => {
    const out = zipStore([{ name: "a.txt", data: "hello" }, { name: "dir/b.xml", data: "<x/>" }]);
    const files = await unzip(out);
    expect(files.map((f) => f.name)).toEqual(["a.txt", "dir/b.xml"]);
    expect(new TextDecoder().decode(files[1]!.data)).toBe("<x/>");
  });
});

describe("the workbook", () => {
  it("names columns past Z", () => {
    expect([columnName(0), columnName(25), columnName(26), columnName(701), columnName(702)]).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
  });

  it("escapes what XML cannot hold, and drops what it cannot carry", () => {
    expect(xmlText('a<b>&"c"\u0007')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
  });

  it("holds money in dollars and a percent as a true percent", () => {
    expect(kpiCell(12550, "money").v).toBe(125.5);
    expect(kpiCell(62.5, "percent").v).toBe(0.625);
    expect(kpiCell(null, "count").v).toBeNull();
  });

  it("reads back: the report's rows, each sheet", async () => {
    const r = report({ fromDate: "2026-09-01", toDate: "2026-10-31" }, { referrals: [referral("2026-09-02", "admitted", "=HYPERLINK(1) & <b>")] });
    const y = buildYearOverYear(r, report({ fromDate: "2025-09-01", toDate: "2025-10-31" }));
    const bytes = kpiWorkbook(r, y);
    const rows = [...xlsxRows(await unzip(bytes))];
    const flat = rows.map((row) => row.join("|"));
    expect(flat.some((l) => l.startsWith("Measure|Sep 2026|Oct 2026|Period"))).toBe(true);
    expect(flat.some((l) => l.startsWith("Referrals received|1|0|1"))).toBe(true);
    // A source that looks like a formula stays text.
    expect(flat.some((l) => l.startsWith("=HYPERLINK(1) & <b>|1|0|1"))).toBe(true);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("<f>");
    // Escaped in the XML itself: Excel refuses a sheet with a stray < in it.
    expect(text).toContain("=HYPERLINK(1) &amp; &lt;b&gt;");
  });

  it("shades the months entered by hand, and only when there are some", async () => {
    const styles = async (r: KpiReport) => {
      const y = buildYearOverYear(r, report({ fromDate: "2025-09-01", toDate: "2025-10-31" }));
      const files = await unzip(kpiWorkbook(r, y));
      return new TextDecoder().decode(files.find((f) => f.name === "xl/styles.xml")!.data);
    };
    const plain = report({ fromDate: "2026-09-01", toDate: "2026-10-31" });
    expect(await styles(plain)).not.toContain("FEF3C7");
    expect(await styles(applyKpiHistory(plain, [{ month: "2026-09", measure: "referrals", value: 3 }]))).toContain("FEF3C7");
  });

  it("refuses a workbook of no sheets, and keeps sheet names unique and legal", async () => {
    expect(() => buildXlsx([])).toThrow();
    const files = await unzip(buildXlsx([{ name: "a/b", rows: [["x"]] }, { name: "A B", rows: [["y"]] }, { name: "x".repeat(40), rows: [["z"]] }]));
    const wb = new TextDecoder().decode(files.find((f) => f.name === "xl/workbook.xml")!.data);
    expect(wb).toContain('name="a b"');
    expect(wb).toContain('name="A B 2"');
    expect(wb).toContain(`name="${"x".repeat(31)}"`);
  });
});
