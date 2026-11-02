/**
 * /reports — the practice's KPI report (Level-1 doc:80-109; the practice's
 * monthly Trend Report).
 *
 * Every measure the document names, a column a month across any window of the
 * practice's days and the window's own figure last, with each measure's
 * definition one gesture away and the whole table as a CSV. It replaced the
 * operational charts this page had, which the Dashboard shows (client
 * walkthrough 04:51: "Reports and Dashboard are the same").
 */
"use client";

import Link from "next/link";
import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";

import { PeriodPicker } from "@/components/reports/period-picker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { formatKpi, kpiMonthLabel, type KpiReport, type KpiRow } from "@/lib/features/reports/kpi-report";
import { yearChange, type KpiYearOverYear } from "@/lib/features/reports/kpi-year-over-year";
import { REPORT_PRESET_LABELS, presetFor, type ReportRange } from "@/lib/features/reports/report-range";

type Loaded = { ok: true; data: KpiReport } | { ok: false; error: string };

const query = (r?: ReportRange) => (r ? `?fromDate=${r.fromDate}&toDate=${r.toDate}` : "");

async function fetchReport(r?: ReportRange): Promise<Loaded> {
  try {
    const d = await fetch(`/api/reports/kpis${query(r)}`).then((res) => res.json());
    return d.success ? { ok: true, data: d.data } : { ok: false, error: d.error ?? "Failed." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

async function fetchYear(r?: ReportRange): Promise<KpiYearOverYear | null> {
  try {
    const d = await fetch(`/api/reports/kpis/year-over-year${query(r)}`).then((res) => res.json());
    return d.success ? d.data : null;
  } catch {
    return null;
  }
}

export default function ReportsPage() {
  const [data, setData] = useState<KpiReport | null>(null);
  const [year, setYear] = useState<KpiYearOverYear | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [canExport, setCanExport] = useState(false);
  // Only the latest request may land: two quick preset clicks can answer out
  // of order, and the slower first one would put its window back.
  const latest = useRef(0);

  function apply(loaded: Loaded, seq: number) {
    if (seq !== latest.current) return;
    setLoading(false);
    if (!loaded.ok) {
      // Keep the report on screen; the window that failed says why.
      if (data) setRangeError(loaded.error);
      else setError(loaded.error);
      return;
    }
    setData(loaded.data);
    setRangeError(null);
  }

  const applyFirst = useEffectEvent((loaded: Loaded, seq: number) => apply(loaded, seq));
  useEffect(() => {
    const seq = ++latest.current;
    void fetchReport().then((loaded) => applyFirst(loaded, seq));
    void fetchYear().then((y) => {
      if (seq === latest.current) setYear(y);
    });
    // The download is offered to whoever holds the grant its route enforces.
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const perms: string[] = d.data?.permissions ?? [];
        setCanExport(Boolean(d.success) && (perms.includes("reports.export") || d.data?.role === "platform_admin"));
      })
      .catch(() => {});
  }, []);

  function show(r: ReportRange) {
    const seq = ++latest.current;
    setLoading(true);
    setRangeError(null);
    setYear(null);
    void fetchReport(r).then((loaded) => apply(loaded, seq));
    void fetchYear(r).then((y) => {
      if (seq === latest.current) setYear(y);
    });
  }

  if (!data) {
    if (error) {
      return (
        <div className="px-8 py-8">
          <div role="alert" className="text-sm text-red-700 bg-red-50 rounded px-3 py-2">{error}</div>
        </div>
      );
    }
    return <div className="px-8 py-8 text-sm text-slate-500">Loading the report…</div>;
  }

  const activePreset = presetFor(data.range, data.today);
  const anyEntered = data.sections.some((s) => s.rows.some((r) => r.entered?.length));

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl tracking-tight">KPI report</h1>
            <p className="text-slate-600 mt-1 tabular">
              {data.range.fromDate} → {data.range.toDate}
              {activePreset && <span className="text-slate-400"> · {REPORT_PRESET_LABELS[activePreset]}</span>}
              {loading && <span className="text-slate-400"> · Updating…</span>}
            </p>
          </div>
          {canExport && (
            <div className="flex gap-2">
              <Link
                href="/reports/board"
                className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"
              >
                Board report
              </Link>
              <a
                href={`/api/reports/kpis/xlsx${query(data.range)}`}
                className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"
              >
                Download Excel
              </a>
              <a
                href={`/api/reports/kpis/csv${query(data.range)}`}
                className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"
              >
                Download CSV
              </a>
            </div>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-sm text-slate-500">
          A column a month, the period&rsquo;s own figure last. Each measure&rsquo;s{" "}
          <span className="whitespace-nowrap">ⓘ</span> says exactly what is counted. Archived charts are left out of the
          patient and visit measures; their bills stay in the money.{" "}
          <Link href="/reports/history" className="text-[var(--color-brand-700)] hover:underline">
            Monthly history
          </Link>{" "}
          holds the figures for months before Pallio, and your plan.
          {anyEntered && <span className="italic text-amber-800"> Figures in italics were entered by hand.</span>}
        </p>
        <div className="mt-4">
          <PeriodPicker range={data.range} today={data.today} onPick={show} error={rangeError} />
        </div>
      </header>

      <div className="space-y-4">
        {year && <YearOverYear year={year} />}
        {data.sections.map((s) => (
          <Card key={s.key}>
            <CardHeader>
              <CardTitle>{s.title}</CardTitle>
              <CardDescription className="sr-only">{s.rows.length} measures</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label={s.title}>
                  <thead className="text-xs text-slate-500">
                    <tr>
                      <th scope="col" className="sticky left-0 z-10 bg-white text-left font-semibold py-1 pr-4 min-w-[16rem]">
                        Measure
                      </th>
                      {data.months.map((m) => (
                        <th key={m.key} scope="col" className="text-right font-semibold py-1 px-2 whitespace-nowrap">
                          {kpiMonthLabel(m)}
                        </th>
                      ))}
                      <th scope="col" className="text-right font-semibold py-1 pl-3 whitespace-nowrap border-l border-slate-200">
                        Period
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {s.rows.map((r) => (
                      <Fragment key={r.key}>
                        <MeasureRow r={r} />
                        {r.children?.map((c) => <MeasureRow key={c.key} r={c} part />)}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function YearOverYear({ year }: { year: KpiYearOverYear }) {
  const period = (r: ReportRange) => `${r.fromDate} → ${r.toDate}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Year over year</CardTitle>
        <CardDescription>The period beside the same days a year before. Choose Year to date for the Trend Report&rsquo;s table.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Year over year">
            <thead className="text-xs text-slate-500">
              <tr>
                <th scope="col" className="text-left font-semibold py-1 pr-4 min-w-[16rem]">Measure</th>
                <th scope="col" className="text-right font-semibold py-1 px-2 whitespace-nowrap">{period(year.prior)}</th>
                <th scope="col" className="text-right font-semibold py-1 px-2 whitespace-nowrap">{period(year.current)}</th>
                <th scope="col" className="text-right font-semibold py-1 pl-3 whitespace-nowrap border-l border-slate-200">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {year.rows.map((r) => (
                <tr key={r.key} className="text-slate-900">
                  <th scope="row" className="text-left font-medium py-1.5 pr-4">
                    {r.label}
                    <InfoTip label={`About ${r.label}`}>{r.definition}</InfoTip>
                  </th>
                  <td className="text-right tabular py-1.5 px-2 whitespace-nowrap">{formatKpi(r.prior, r.unit)}</td>
                  <td className="text-right tabular py-1.5 px-2 whitespace-nowrap font-semibold">{formatKpi(r.current, r.unit)}</td>
                  <td className="text-right tabular py-1.5 pl-3 whitespace-nowrap border-l border-slate-200">{yearChange(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function MeasureRow({ r, part = false }: { r: KpiRow; part?: boolean }) {
  return (
    <tr className={part ? "text-slate-600" : "text-slate-900"}>
      <th
        scope="row"
        className={`sticky left-0 z-10 bg-white text-left font-normal py-1.5 pr-4 ${part ? "pl-4 text-xs" : "font-medium"}`}
      >
        {r.label}
        <InfoTip label={`About ${r.label}`}>
          {r.definition}
          <span className="block mt-1 text-slate-500">{r.source}</span>
        </InfoTip>
      </th>
      {r.months.map((v, k) => (
        <td
          key={k}
          title={r.entered?.includes(k) ? "Entered by hand on Monthly history" : undefined}
          className={`text-right tabular py-1.5 px-2 whitespace-nowrap ${part ? "text-xs" : ""} ${r.entered?.includes(k) ? "italic text-amber-800" : ""}`}
        >
          {formatKpi(v, r.unit)}
        </td>
      ))}
      <td className={`text-right tabular py-1.5 pl-3 whitespace-nowrap border-l border-slate-200 font-semibold ${part ? "text-xs font-normal" : ""}`}>
        {formatKpi(r.total, r.unit)}
      </td>
    </tr>
  );
}
