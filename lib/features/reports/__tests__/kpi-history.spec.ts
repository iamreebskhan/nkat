/**
 * Monthly history (0125): an entered figure stands for its month, what depends
 * on it is worked out again, and the save refuses what Pallio should not keep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { applyKpiHistory, planFor, SaveKpiHistorySchema, type KpiEntered, type KpiReason } from "../kpi-history";
import { getKpiHistoryYear, saveKpiHistory } from "../kpi-history.service";
import { buildKpiReport, kpiCsv, type KpiInputs, type KpiReport, type KpiRow } from "../kpi-report";
import { buildYearOverYear } from "../kpi-year-over-year";

const RANGE = { fromDate: "2026-01-01", toDate: "2026-03-31" };
const report = (over: Partial<KpiInputs> = {}, range = RANGE): KpiReport =>
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
const values = (r: KpiReport, key: string) => [...find(r, key).months, find(r, key).total];

const e = (month: string, measure: string, value: number): KpiEntered => ({ month, measure, value });
const REASONS: KpiReason[] = [
  { kind: "discharge", code: "01", label: "Hospice - partner", category: "hospice_partner" },
  { kind: "ntuc", code: "24", label: "Unable to contact", category: "lost_contact" },
];

describe("an entered figure", () => {
  it("stands for its month and is marked, the others staying as counted", () => {
    const base = report({ referrals: [{ receivedOn: "2026-02-10", stage: "admitted", source: "A", ntucOn: null, ntucReason: null, firstVisitOn: null }] });
    const r = applyKpiHistory(base, [e("2026-01", "referrals", 30), e("2026-01", "admitted", 15)]);
    expect(values(r, "referrals")).toEqual([30, 1, 0, 31]);
    expect(values(r, "referrals:admitted")).toEqual([15, 1, 0, 16]);
    expect(find(r, "referrals").entered).toEqual([0]);
    // Worked out again, on the entered figures.
    expect(values(r, "conversion")).toEqual([50, 100, null, 51.6]);
    expect(find(r, "conversion").entered).toEqual([0]);
  });

  it("leaves what it cannot say as not recorded, never a zero", () => {
    const r = applyKpiHistory(report(), [e("2026-01", "referrals", 30)]);
    expect(find(r, "referrals:ntuc").months[0]).toBeNull();
    expect(find(r, "referrals:open").months[0]).toBeNull();
    expect(find(r, "source_referrals").months[0]).toBeNull();
    expect(find(r, "referrals:ntuc").months[1]).toBe(0);
    const whole = applyKpiHistory(report(), [e("2026-01", "referrals", 30), e("2026-02", "referrals", 20), e("2026-03", "referrals", 10)]);
    expect(find(whole, "referrals:ntuc").total).toBeNull();
  });

  it("takes money in dollars", () => {
    const r = applyKpiHistory(report(), [e("2026-01", "billed", 1234.56)]);
    expect(values(r, "billed")).toEqual([123456, 0, 0, 123456]);
  });

  it("takes the census at the window's end, not a sum", () => {
    const r = applyKpiHistory(report(), [e("2026-01", "census", 40), e("2026-02", "census", 50), e("2026-03", "census", 60)]);
    expect(values(r, "census")).toEqual([40, 50, 60, 60]);
    const earlier = applyKpiHistory(report(), [e("2026-01", "census", 40)]);
    expect(find(earlier, "census").total).toBe(0);
  });

  it("adds new and follow-up into the Trend Report's total and into visits made, keeping the other kinds", () => {
    const visit = (day: string, codingBasis: string) => ({ patientId: "p", clinicianId: "c", clinicianName: "C", day, codingBasis, cptCodes: [] });
    const base = report({ visits: [visit("2026-01-05", "new_patient_home"), visit("2026-01-06", "non_billable")] });
    const r = applyKpiHistory(base, [e("2026-01", "visits_new", 9), e("2026-01", "visits_followup", 46)]);
    expect(values(r, "visits_new_followup")).toEqual([55, 0, 0, 55]);
    // 55 entered, plus the one visit not billed that was counted.
    expect(values(r, "visits")).toEqual([56, 0, 0, 56]);
    expect(values(r, "visits:type:New patient")).toEqual([9, 0, 0, 9]);
    expect(values(r, "visits:type:Follow-up")).toEqual([46, 0, 0, 46]);
  });

  it("works out transitions and the partner's share", () => {
    const r = applyKpiHistory(report(), [e("2026-01", "to_partner", 6), e("2026-01", "to_other", 2), e("2026-02", "deaths", 2)]);
    expect(values(r, "transitions")).toEqual([8, 0, 0, 8]);
    expect(values(r, "transitions_partner_share")).toEqual([75, null, null, 75]);
    expect(values(r, "deaths")).toEqual([0, 2, 0, 2]);
  });

  it("lists counts by reason under their code, with the month's total", () => {
    const r = applyKpiHistory(report(), [e("2026-01", "discharge:01", 4), e("2026-02", "ntuc:24", 3)], REASONS);
    expect(values(r, "discharges:01 Hospice - partner")).toEqual([4, 0, 0, 4]);
    expect(values(r, "discharges")).toEqual([4, 0, 0, 4]);
    expect(values(r, "ntuc:24 Unable to contact")).toEqual([0, 3, 0, 3]);
    expect(values(r, "ntuc")).toEqual([0, 3, 0, 3]);
  });

  it("says where it differs from what Pallio counts, in the figure's own unit", () => {
    const bill = { patientId: "p", clinicianId: null, clinicianName: null, status: "paid", dos: "2026-01-05", billedCents: 10000, paidCents: 0, submittedOn: null };
    const r = applyKpiHistory(report({ bills: [bill] }), [e("2026-01", "billed", 250), e("2026-02", "billed", 400)]);
    expect(r.differences).toEqual([{ month: "2026-01", label: "Billing", unit: "money", entered: 25000, pallio: 10000 }]);
  });

  it("CONTROL: is left out of a month the window only partly holds", () => {
    const part = report({}, { fromDate: "2026-01-15", toDate: "2026-02-28" });
    const r = applyKpiHistory(part, [e("2026-01", "referrals", 30), e("2026-02", "referrals", 20)]);
    expect(values(r, "referrals")).toEqual([0, 20, 20]);
  });

  it("CONTROL: with nothing entered the report is the one that came in", () => {
    const base = report();
    expect(applyKpiHistory(base, [])).toBe(base);
    expect(applyKpiHistory(base, [e("2019-01", "referrals", 3)])).toBe(base);
  });

  it("does not change the report it was given", () => {
    const base = report();
    applyKpiHistory(base, [e("2026-01", "referrals", 30)]);
    expect(find(base, "referrals").months[0]).toBe(0);
    expect(find(base, "referrals").entered).toBeUndefined();
  });

  it("names the entered months in the CSV", () => {
    const csv = kpiCsv(applyKpiHistory(report(), [e("2026-01", "referrals", 30), e("2026-03", "referrals", 20)]));
    const line = csv.split("\r\n").find((l) => l.includes("Referrals received"))!;
    expect(line.endsWith("Jan 2026; Mar 2026")).toBe(true);
  });

  it("feeds the year-over-year table", () => {
    const y = buildYearOverYear(
      applyKpiHistory(report(), [e("2026-01", "referrals", 30), e("2026-02", "referrals", 30), e("2026-03", "referrals", 30)]),
      applyKpiHistory(report({}, { fromDate: "2025-01-01", toDate: "2025-03-31" }), [e("2025-02", "referrals", 60)]),
    );
    expect(y.rows.find((r) => r.key === "referrals")).toMatchObject({ prior: 60, current: 90 });
  });
});

describe("the plan", () => {
  const plan = [e("2026-01", "plan:billing", 18000), e("2026-02", "plan:billing", 24000), e("2026-02", "plan:census", 100)];

  it("carries forward from the latest at or before the month", () => {
    expect(planFor(plan, "plan:billing", "2026-06")).toBe(24000);
    expect(planFor(plan, "plan:billing", "2026-01")).toBe(18000);
  });

  it("CONTROL: is nothing before it was set, or for another measure", () => {
    expect(planFor(plan, "plan:billing", "2025-12")).toBeNull();
    expect(planFor(plan, "plan:admissions", "2026-06")).toBeNull();
  });
});

describe("the save", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const USER = "22222222-2222-4222-8222-222222222222";
  const NOW = new Date("2026-10-15T16:00:00Z");
  let writes: { sql: string; values: unknown[] }[];

  const reasons = [{ kind: "discharge", code: "01", label: "Hospice", category: "hospice_partner" }];
  beforeEach(() => {
    vi.clearAllMocks();
    writes = [];
    const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("¶");
      if (sql.includes("INSERT") || sql.includes("DELETE")) {
        writes.push({ sql, values });
        return Promise.resolve(1);
      }
      if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: "America/New_York" }]);
      if (sql.includes("FROM org_reason_code")) return Promise.resolve(reasons);
      if (sql.includes("FROM org_kpi_month")) return Promise.resolve([{ month: "2026-01", measure: "referrals", value: "34" }]);
      return Promise.resolve([]);
    };
    vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)({ $queryRaw: run, $executeRaw: run }));
  });

  const save = (changes: { month: string; measure: string; value: number | null }[]) => saveKpiHistory({ orgId: ORG, userId: USER, changes, now: NOW });

  it("writes figures and clears the rest, and the audit holds no figure", async () => {
    const r = await save([
      { month: "2026-01", measure: "referrals", value: 34 },
      { month: "2026-02", measure: "discharge:01", value: 7 },
      { month: "2026-03", measure: "billed", value: null },
    ]);
    expect(r).toEqual({ entered: 2, cleared: 1 });
    expect(writes).toHaveLength(2);
    expect(writes[0]!.sql).toContain("ON CONFLICT (org_id, month, measure)");
    const audit = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(audit).toMatchObject({ action: "kpi_history_change", payload: { entered: 2, cleared: 1, from: "2026-01", to: "2026-03" } });
    expect(JSON.stringify(audit.payload)).not.toContain("34");
  });

  it("lets a plan run ahead, and an actual only up to the month under way", async () => {
    await expect(save([{ month: "2027-03", measure: "plan:billing", value: 24000 }])).resolves.toBeTruthy();
    await expect(save([{ month: "2026-10", measure: "referrals", value: 3 }])).resolves.toBeTruthy();
    await expect(save([{ month: "2026-11", measure: "referrals", value: 3 }])).rejects.toThrow("still ahead");
  });

  it("CONTROL: refuses a measure Pallio does not keep, or part of a count, writing nothing", async () => {
    await expect(save([{ month: "2026-01", measure: "ssn", value: 1 }])).rejects.toThrow("not a figure");
    await expect(save([{ month: "2026-01", measure: "discharge:99", value: 1 }])).rejects.toThrow("not a figure");
    await expect(save([{ month: "2026-01", measure: "referrals", value: 1.5 }])).rejects.toThrow("whole number");
    expect(writes).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("takes cents on money", async () => {
    await expect(save([{ month: "2026-01", measure: "billed", value: 1234.56 }])).resolves.toBeTruthy();
  });

  it("refuses a month that is not one, a negative figure and an empty save", () => {
    expect(SaveKpiHistorySchema.safeParse({ changes: [{ month: "2026-13", measure: "referrals", value: 1 }] }).success).toBe(false);
    expect(SaveKpiHistorySchema.safeParse({ changes: [{ month: "2026-01", measure: "referrals", value: -1 }] }).success).toBe(false);
    expect(SaveKpiHistorySchema.safeParse({ changes: [] }).success).toBe(false);
  });

  it("gives a year's figures with the practice's reason codes as measures", async () => {
    const y = await getKpiHistoryYear({ orgId: ORG, year: 2026, now: NOW });
    expect(y.thisMonth).toBe("2026-10");
    expect(y.values).toEqual({ referrals: { "2026-01": 34 } });
    expect(y.groups.map((g) => g.title)).toEqual(["Plan", "Actuals", "Discharges, by reason", "Not taken under care, by reason"]);
    expect(y.groups[2]!.measures).toEqual([{ key: "discharge:01", label: "01 Hospice", unit: "count" }]);
  });
});
