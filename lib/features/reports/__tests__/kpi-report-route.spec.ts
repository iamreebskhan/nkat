/**
 * GET /api/reports/kpis and /csv (doc:80-109): who may read and take the
 * report, which windows are refused, and what every statement reads. lib/db is
 * mocked with a fake tx answering by statement; the definitions are
 * kpi-report.spec's.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { POST as postBoardFile } from "@/app/api/reports/board/file/route";
import { GET as getBoard } from "@/app/api/reports/board/route";
import { GET as getHistory, PUT as putHistory } from "@/app/api/reports/history/route";
import { GET as getCsv } from "@/app/api/reports/kpis/csv/route";
import { GET } from "@/app/api/reports/kpis/route";
import { GET as getXlsx } from "@/app/api/reports/kpis/xlsx/route";
import { GET as getYear } from "@/app/api/reports/kpis/year-over-year/route";
import { requireAuth, type Session } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";

import { getKpiReport } from "../kpi-report.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const session: Session = { userId: "u", orgId: ORG, role: "org_admin", permissions: ["reports.view", "reports.export"], email: "a@b.test" };

let calls: { sql: string; values: unknown[] }[];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: "America/New_York" }]);
    if (sql.includes("FROM superbill s") && !sql.includes("superbill_denial")) {
      return Promise.resolve([
        { patient_id: "p", clinician_user_id: "h", clinician_name: "Helen Okafor", status: "paid", dos: "2026-10-02", billed_amount_cents: BigInt(12500), paid_amount_cents: BigInt(5616), submitted_on: "2026-10-03" },
      ]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  vi.mocked(requireAuth).mockResolvedValue(session);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const req = (path: string) => new Request(`http://localhost${path}`) as unknown as NextRequest;
const statement = (fragment: string) => calls.find((c) => c.sql.includes(fragment))!;

describe("the routes", () => {
  it("reads with reports.view and takes the CSV with reports.export", async () => {
    expect((await GET(req("/api/reports/kpis"))).status).toBe(200);
    expect(vi.mocked(requireAuth).mock.calls[0]![0]).toEqual(["reports.view"]);
    const csv = await getCsv(req("/api/reports/kpis/csv?fromDate=2026-10-01&toDate=2026-10-28"));
    expect(vi.mocked(requireAuth).mock.calls[1]![0]).toEqual(["reports.export"]);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="pallio-kpis-2026-10-01-to-2026-10-28.csv"');
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("section,measure,part of,unit,source,definition,Oct 2026 (1-28),2026-10-01 to 2026-10-28,entered by hand");
    expect(text).toContain("Billing and revenue,Charges billed,,dollars,doc:102,");
  });

  it("takes the year-over-year with reports.view, and the workbook with reports.export", async () => {
    const year = await getYear(req("/api/reports/kpis/year-over-year?fromDate=2026-01-01&toDate=2026-06-30"));
    expect(year.status).toBe(200);
    expect(vi.mocked(requireAuth).mock.calls[0]![0]).toEqual(["reports.view"]);
    expect((await year.json()).data.prior).toEqual({ fromDate: "2025-01-01", toDate: "2025-06-30" });
    const book = await getXlsx(req("/api/reports/kpis/xlsx?fromDate=2026-01-01&toDate=2026-06-30"));
    expect(vi.mocked(requireAuth).mock.calls[1]![0]).toEqual(["reports.export"]);
    expect(book.headers.get("content-disposition")).toBe('attachment; filename="pallio-kpis-2026-01-01-to-2026-06-30.xlsx"');
  });

  it("reads monthly history with reports.view, and changing it needs settings.org", async () => {
    await getHistory(req("/api/reports/history?year=2026"));
    expect(vi.mocked(requireAuth).mock.calls[0]![0]).toEqual(["reports.view"]);
    vi.mocked(requireAuth).mockResolvedValue(new Response(null, { status: 403 }) as never);
    const put = new Request("http://localhost/api/reports/history", { method: "PUT", body: JSON.stringify({ changes: [{ month: "2026-01", measure: "referrals", value: 1 }] }) });
    expect((await putHistory(put as unknown as NextRequest)).status).toBe(403);
    expect(vi.mocked(requireAuth).mock.calls[1]![0]).toEqual(["settings.org"]);
    expect(calls.filter((c) => c.sql.includes("INSERT"))).toHaveLength(0);
  });

  it("reads the board report with reports.view, and takes its file with reports.export", async () => {
    expect((await getBoard(req("/api/reports/board?month=2026-06"))).status).toBe(200);
    expect(vi.mocked(requireAuth).mock.calls[0]![0]).toEqual(["reports.view"]);
    const file = new Request("http://localhost/api/reports/board/file", { method: "POST", body: JSON.stringify({ month: "2026-06", format: "xlsx" }) });
    const res = await postBoardFile(file as unknown as NextRequest);
    expect(vi.mocked(requireAuth).mock.calls.at(-1)![0]).toEqual(["reports.export"]);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="pallio-board-report-2026-06.xlsx"');
  });

  it("CONTROL: refuses a board report for a month still ahead", async () => {
    const res = await getBoard(req("/api/reports/board?month=2099-01"));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("That month is still ahead.");
  });

  it("CONTROL: refuses a day that does not exist, and a window that runs backwards, reading nothing", async () => {
    const bad = await GET(req("/api/reports/kpis?fromDate=2026-09-31&toDate=2026-10-28"));
    expect(bad.status).toBe(422);
    expect(calls).toHaveLength(0);
    const backwards = await GET(req("/api/reports/kpis?fromDate=2026-10-28&toDate=2026-10-01"));
    expect(backwards.status).toBe(422);
    expect((await backwards.json()).error).toBe("The range starts after it ends.");
  });

  it("CONTROL: answers the auth refusal as it comes, reading nothing", async () => {
    vi.mocked(requireAuth).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await getCsv(req("/api/reports/kpis/csv"))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("what the service reads", () => {
  it("defaults to the twelve calendar months to the practice's today", async () => {
    // 01:00 UTC on 1 Nov is still 31 Oct in New York.
    const r = await getKpiReport({ orgId: ORG, now: new Date("2026-11-01T01:00:00Z") });
    expect(r.range).toEqual({ fromDate: "2025-11-01", toDate: "2026-10-31" });
    expect(r.months).toHaveLength(12);
  });

  it("names the org in every statement, and leaves archived charts out of all but the money", async () => {
    await getKpiReport({ orgId: ORG, fromDay: "2026-10-01", toDay: "2026-10-28" });
    const reads = calls.filter((c) => !c.sql.includes("SELECT timezone FROM org"));
    expect(reads).toHaveLength(14);
    for (const c of reads) expect(c.values, c.sql.slice(0, 80)).toContain(ORG);
    for (const c of reads) {
      const figures = c.sql.includes("FROM superbill s") || c.sql.includes("FROM superbill_denial") || c.sql.includes("FROM org_kpi_month");
      expect(c.sql.includes("'archived'"), c.sql.slice(0, 80)).toBe(!figures);
    }
  });

  it("never counts a PCM/CCM month as a visit made", async () => {
    await getKpiReport({ orgId: ORG, fromDay: "2026-10-01", toDay: "2026-10-28" });
    expect(statement("t.coding_basis, v.cpt_codes_assigned").values).toContain("pcm_ccm_month");
    expect(statement("AS first_visit_on").values).toContain("pcm_ccm_month");
  });

  it("hands the money through in cents", async () => {
    const r = await getKpiReport({ orgId: ORG, fromDay: "2026-10-01", toDay: "2026-10-28" });
    const billed = r.sections.find((s) => s.key === "revenue")!.rows.find((x) => x.key === "billed")!;
    expect([billed.months, billed.total]).toEqual([[12500], 12500]);
  });
});
