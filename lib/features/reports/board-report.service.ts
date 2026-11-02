/**
 * The monthly board report's reads: the KPI report over the windows the month
 * needs, the plan, the reason codes, and one count no report holds. Everything
 * goes through getKpiReport, so entered months are in it (0125). Counts and money
 * only; no patient is named. The PDF is the deck's slides, printed by the same
 * headless browser the other PDFs use.
 */
import puppeteer, { type Browser } from "puppeteer";

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import { boardWindows, buildBoardReport, type BoardReport } from "./board-report";
import { readPlanMonths, readReasons } from "./kpi-history.service";
import { monthEnd } from "./kpi-report";
import { getKpiReport, getKpiYearOverYear } from "./kpi-report.service";

const lastMonth = (month: string) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

export async function getBoardReport(args: { orgId: string; month?: string; celebrations?: string[]; now?: Date }): Promise<BoardReport> {
  const org = args.orgId;
  const base = await withOrgContext(org, async (tx) => {
    const today = orgToday(await readOrgTimeZone(tx, org), args.now);
    const named = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM org WHERE id = ${org}::uuid`;
    const month = args.month ?? lastMonth(today.slice(0, 7));
    if (month > today.slice(0, 7)) throw new ValidationError("That month is still ahead.");
    const from = `${month}-01`;
    const to = monthEnd(month);
    const both = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT r.patient_id)::int AS n
        FROM referral r
        JOIN patient_discharge d ON d.patient_id = r.patient_id AND d.org_id = r.org_id
       WHERE r.org_id = ${org}::uuid AND r.stage = 'ntuc'
         AND r.ntuc_on BETWEEN ${from}::date AND ${to}::date
         AND d.discharged_on BETWEEN ${from}::date AND ${to}::date
    `;
    return {
      today, month, orgName: named[0]?.name ?? "Your practice",
      plan: await readPlanMonths(tx, org), reasons: await readReasons(tx, org), onBothLists: Number(both[0]?.n ?? 0),
    };
  });
  const windows = boardWindows(base.month);
  const window = (w: { fromDate: string; toDate: string }) => ({ orgId: org, fromDay: w.fromDate, toDay: w.toDate, now: args.now });
  const [span, twelve, year] = await Promise.all([getKpiReport(window(windows.span)), getKpiReport(window(windows.twelve)), getKpiYearOverYear(window(windows.year))]);
  return buildBoardReport({ ...base, span, twelve, yearReport: year.report, year: year.year, celebrations: args.celebrations ?? [] });
}

let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  _browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  return _browser;
}

/** The slides' HTML as a PDF: one 16:9 page a slide. */
export async function boardPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // domcontentloaded is enough: the HTML is fully inline.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await page.close();
  }
}
