/**
 * /reports/history — the figures a practice reported for months Pallio has no
 * data for, and its plan (0125). A year at a time, a column a month. A row or a
 * block copied from a spreadsheet can be pasted into a cell: it fills to the
 * right and down from there.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Select } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { KpiHistoryMeasure } from "@/lib/features/reports/kpi-history";
import type { KpiHistoryYear } from "@/lib/features/reports/kpi-history.service";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const cellKey = (measure: string, month: string) => `${measure}|${month}`;

/** What a cell holds: "" is empty, as is anything a spreadsheet writes for nothing. */
const clean = (s: string) => s.replace(/[$,\s]/g, "").replace(/^-$/, "");

function parseCell(text: string, unit: KpiHistoryMeasure["unit"]): number | null | "bad" {
  const s = clean(text);
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "bad";
  const n = Number(s);
  return unit === "count" && !Number.isInteger(n) ? "bad" : n;
}

export default function ReportHistoryPage() {
  const [year, setYear] = useState<number | null>(null);
  const [data, setData] = useState<KpiHistoryYear | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((y: number | null) => {
    fetch(`/api/reports/history${y ? `?year=${y}` : ""}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return setFailed(d.error ?? "Could not load the figures.");
        setFailed(null);
        setData(d.data);
        setYear(d.data.year);
        setDraft({});
      })
      .catch(() => setFailed("Network error."));
  }, []);

  useEffect(() => {
    load(null);
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const perms: string[] = d.data?.permissions ?? [];
        setCanEdit(Boolean(d.success) && (perms.includes("settings.org") || d.data?.role === "platform_admin"));
      })
      .catch(() => {});
  }, [load]);

  if (!data) {
    return (
      <div className="px-8 py-8 text-sm">
        {failed ? <p role="alert" className="text-red-700">{failed}</p> : <p className="text-slate-500">Loading…</p>}
      </div>
    );
  }

  const months = MONTHS.map((_, i) => `${data.year}-${String(i + 1).padStart(2, "0")}`);
  const flat = data.groups.flatMap((g) => g.measures.map((m) => ({ m, ahead: g.ahead })));
  const stored = (measure: string, month: string) => data.values[measure]?.[month];
  const shown = (measure: string, month: string) => draft[cellKey(measure, month)] ?? stored(measure, month)?.toString() ?? "";
  const locked = (ahead: boolean, month: string) => !canEdit || (!ahead && month > data.thisMonth);

  // The cells whose value differs from what is stored, in save form.
  const changes: { month: string; measure: string; value: number | null }[] = [];
  const invalid: string[] = [];
  for (const { m } of flat) {
    for (const month of months) {
      const text = draft[cellKey(m.key, month)];
      if (text === undefined) continue;
      const value = parseCell(text, m.unit);
      if (value === "bad") invalid.push(`${m.label}, ${month}`);
      else if (value !== (stored(m.key, month) ?? null)) changes.push({ month, measure: m.key, value });
    }
  }

  function setCell(measure: string, month: string, text: string) {
    setMsg(null);
    setDraft((d) => ({ ...d, [cellKey(measure, month)]: text }));
  }

  function paste(e: React.ClipboardEvent<HTMLInputElement>, row: number, column: number) {
    // Blanks are cells too: a row copied with one figure in it keeps its place.
    const text = e.clipboardData.getData("text/plain").replace(/\r/g, "").replace(/\n$/, "");
    if (!/[\t\n]/.test(text)) return;
    e.preventDefault();
    const lines = text.split("\n").map((l) => l.split("\t"));
    const next: Record<string, string> = {};
    let filled = 0;
    let skipped = 0;
    lines.forEach((cells, r) => {
      const target = flat[row + r];
      cells.forEach((cell, c) => {
        const month = months[column + c];
        if (!target || !month || locked(target.ahead, month)) {
          skipped++;
          return;
        }
        next[cellKey(target.m.key, month)] = clean(cell);
        filled++;
      });
    });
    setDraft((d) => ({ ...d, ...next }));
    setMsg({ ok: true, text: `Pasted ${filled} ${filled === 1 ? "cell" : "cells"}${skipped ? `; ${skipped} fell outside the table or on a month still ahead` : ""}. Not saved yet.` });
  }

  function chooseYear(next: number) {
    if ((changes.length > 0 || invalid.length > 0) && !window.confirm("Leave this year without saving the changes?")) return;
    setMsg(null);
    load(next);
  }

  async function save() {
    if (invalid.length > 0) {
      setMsg({ ok: false, text: `Not a figure: ${invalid.slice(0, 3).join("; ")}${invalid.length > 3 ? ` and ${invalid.length - 3} more` : ""}. Counts are whole numbers; money has at most two decimal places.` });
      return;
    }
    if (changes.length === 0) return setMsg({ ok: false, text: "Nothing has changed." });
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch("/api/reports/history", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes }),
      }).then((r) => r.json());
      if (!d.success) return setMsg({ ok: false, text: d.error ?? "Not saved." });
      setMsg({ ok: true, text: `Saved ${changes.length} ${changes.length === 1 ? "figure" : "figures"}. Every report now uses them.` });
      load(data!.year);
    } catch {
      setMsg({ ok: false, text: "Network error — not saved." });
    } finally {
      setBusy(false);
    }
  }

  const firstYear = Math.min(2020, data.year);
  const lastYear = Number(data.thisMonth.slice(0, 4)) + 1;
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => lastYear - i);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <p className="text-sm">
          <Link href="/reports" className="text-[var(--color-brand-700)] hover:underline">
            ← KPI report
          </Link>
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl tracking-tight">Monthly history</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              The figures you reported for months Pallio has no data for, and your plan. A figure entered here stands for its whole month in
              every report, marked as entered. A plan figure carries forward until you enter the next one. Copy a row or a block from a
              spreadsheet and paste it into a cell: it fills to the right and down.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="history-year" className="text-sm text-slate-600">
              Year
            </label>
            <Select id="history-year" value={String(year ?? data.year)} onChange={(e) => chooseYear(Number(e.target.value))}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </header>

      {failed && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {failed}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{data.year}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={`Monthly figures, ${data.year}`}>
              <thead className="text-xs text-slate-500">
                <tr>
                  <th scope="col" className="sticky left-0 z-10 bg-white text-left font-semibold py-1 pr-4 min-w-[16rem]">
                    Measure
                  </th>
                  {MONTHS.map((m) => (
                    <th key={m} scope="col" className="text-right font-semibold py-1 px-1">
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => {
                  const offset = flat.findIndex((x) => x.m.key === g.measures[0]?.key);
                  return [
                    <tr key={g.title}>
                      <th colSpan={13} scope="colgroup" className="sticky left-0 bg-slate-50 px-2 py-1 text-left text-xs font-semibold text-slate-700">
                        {g.title}
                      </th>
                    </tr>,
                    ...g.measures.map((m, r) => (
                      <tr key={m.key}>
                        <th scope="row" className="sticky left-0 z-10 bg-white text-left font-normal py-0.5 pr-4 whitespace-nowrap">
                          {m.label}
                          {m.unit === "money" && <span className="text-slate-400"> ($)</span>}
                        </th>
                        {months.map((month, c) => {
                          const value = shown(m.key, month);
                          const bad = draft[cellKey(m.key, month)] !== undefined && parseCell(value, m.unit) === "bad";
                          return (
                            <td key={month} className="px-0.5 py-0.5">
                              <input
                                aria-label={`${m.label}, ${MONTHS[c]} ${data.year}`}
                                inputMode="decimal"
                                value={value}
                                disabled={locked(g.ahead, month)}
                                onChange={(e) => setCell(m.key, month, e.target.value)}
                                onPaste={(e) => paste(e, offset + r, c)}
                                className={`h-7 w-[4.25rem] rounded border px-1 text-right tabular text-sm disabled:bg-slate-50 disabled:text-slate-400 ${
                                  bad ? "border-red-500 bg-red-50" : draft[cellKey(m.key, month)] !== undefined ? "border-amber-400" : "border-slate-200"
                                }`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    )),
                  ];
                })}
              </tbody>
            </table>
          </div>
          {msg && (
            <p role={msg.ok ? "status" : "alert"} className={`mt-3 text-sm ${msg.ok ? "text-slate-700" : "text-red-700"}`}>
              {msg.text}
            </p>
          )}
          {canEdit ? (
            <div className="mt-3 flex items-center justify-end gap-3">
              <span className="text-xs text-slate-500">
                {changes.length > 0 ? `${changes.length} unsaved ${changes.length === 1 ? "change" : "changes"}` : ""}
              </span>
              <Button type="button" size="sm" loading={busy} onClick={() => void save()}>
                Save
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-500">Only someone who manages the practice&rsquo;s settings can change these.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
