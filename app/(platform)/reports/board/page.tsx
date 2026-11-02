/**
 * /reports/board — the month's board report: the workbook, the deck with native
 * charts, and the same slides as a PDF, all built from one report. What needs a
 * person's eye comes first, before anything is downloaded.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Field, Select, TextArea } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { boardMonthLabel, type BoardFormat, type BoardReport } from "@/lib/features/reports/board-report";

const FILES: { format: BoardFormat; label: string }[] = [
  { format: "pptx", label: "Download PowerPoint" },
  { format: "xlsx", label: "Download Excel" },
  { format: "pdf", label: "Download PDF" },
];

const previous = (month: string, back: number) => {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 - back;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};

export default function BoardReportPage() {
  const [data, setData] = useState<BoardReport | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [latestMonth, setLatestMonth] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [celebrations, setCelebrations] = useState("");
  const [canExport, setCanExport] = useState(false);
  const [busy, setBusy] = useState<BoardFormat | null>(null);
  const asked = useRef(0);

  function load(m: string | null) {
    const seq = ++asked.current;
    fetch(`/api/reports/board${m ? `?month=${m}` : ""}`)
      .then((r) => r.json())
      .then((d) => {
        if (seq !== asked.current) return;
        if (!d.success) return setFailed(d.error ?? "Could not build the report.");
        setFailed(null);
        setData(d.data);
        setMonth(d.data.month);
        setLatestMonth((x) => x ?? d.data.month);
      })
      .catch(() => setFailed("Network error."));
  }

  useEffect(() => {
    load(null);
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const perms: string[] = d.data?.permissions ?? [];
        setCanExport(Boolean(d.success) && (perms.includes("reports.export") || d.data?.role === "platform_admin"));
      })
      .catch(() => {});
  }, []);

  async function download(format: BoardFormat) {
    if (!month) return;
    setBusy(format);
    setFileError(null);
    try {
      const res = await fetch("/api/reports/board/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month, format, celebrations: celebrations.split("\n").map((l) => l.trim()).filter(Boolean) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        return setFileError(d?.error ?? "Could not build the file.");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `board-report.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setFileError("Network error — no file was made.");
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <div className="px-8 py-8 text-sm">
        {failed ? <p role="alert" className="text-red-700">{failed}</p> : <p className="text-slate-500">Building the report…</p>}
      </div>
    );
  }

  const months = latestMonth ? Array.from({ length: 36 }, (_, i) => previous(latestMonth, i)) : [data.month];

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <p className="text-sm">
          <Link href="/reports" className="text-[var(--color-brand-700)] hover:underline">
            ← KPI report
          </Link>
        </p>
        <h1 className="mt-2 font-display text-3xl tracking-tight">Board report</h1>
        <p className="mt-1 text-sm text-slate-600">
          The month&rsquo;s plan vs actual, discharges and not taken under care, and year over year, as a workbook, a deck and a PDF. Everything
          is computed from the monthly figures, so the three always agree. Months before Pallio come from{" "}
          <Link href="/reports/history" className="text-[var(--color-brand-700)] hover:underline">
            Monthly history
          </Link>
          .
        </p>
        <div className="mt-4 flex items-center gap-2">
          <label htmlFor="board-month" className="text-sm text-slate-600">
            Month
          </label>
          <Select id="board-month" value={month ?? ""} onChange={(e) => load(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {boardMonthLabel(m)}
              </option>
            ))}
          </Select>
        </div>
        {failed && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {failed}
          </p>
        )}
      </header>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Check before this goes anywhere</CardTitle>
            <CardDescription>None of these changes a figure. Each is something a person should look at.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.exceptions.length === 0 ? (
              <p className="text-sm text-slate-600">Nothing to check for {data.monthLabel}.</p>
            ) : (
              <ul aria-label="Exceptions" className="list-disc space-y-1 pl-5 text-sm text-slate-800">
                {data.exceptions.map((e, i) => (
                  <li key={i}>{e.text}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {canExport ? (
          <Card>
            <CardHeader>
              <CardTitle>The files</CardTitle>
              <CardDescription>The deck has {data.monthLabel}&rsquo;s nine slides that change each month; its charts are PowerPoint&rsquo;s own, so they can be edited.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field id="board-celebrations" label="Celebrations" optional explain={`One a line, for the deck's second slide. Pallio adds the year's visits (${data.highlights.join("; ")}).`}>
                <TextArea id="board-celebrations" rows={4} value={celebrations} onChange={(e) => setCelebrations(e.target.value)} />
              </Field>
              {fileError && (
                <p role="alert" className="text-sm text-red-700">
                  {fileError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {FILES.map((f) => (
                  <Button key={f.format} type="button" variant="secondary" size="sm" loading={busy === f.format} onClick={() => void download(f.format)}>
                    {f.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-slate-500">Downloading the report needs the export permission.</p>
        )}
      </div>
    </div>
  );
}
