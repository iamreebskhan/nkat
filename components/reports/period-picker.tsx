/**
 * The report period control (Level-1 doc:75): presets worked out from the
 * practice's today, and a custom from/to. Shared by the Dashboard, which
 * keeps the period in its URL, and the Reports page.
 */
"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  REPORT_PRESETS,
  REPORT_PRESET_LABELS,
  presetFor,
  presetRange,
  rangeProblem,
  type ReportRange,
} from "@/lib/features/reports/report-range";

export function PeriodPicker({
  range,
  today,
  onPick,
  error,
}: {
  range: ReportRange;
  today: string;
  onPick: (r: ReportRange) => void;
  /** Why the period last asked for was not shown (the server's word). */
  error?: string | null;
}) {
  const active = presetFor(range, today);
  // Re-keyed on the period shown, so the inputs start from it each time.
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Report period">
        {REPORT_PRESETS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={active === p ? "primary" : "secondary"}
            aria-pressed={active === p}
            onClick={() => onPick(presetRange(p, today))}
          >
            {REPORT_PRESET_LABELS[p]}
          </Button>
        ))}
        <CustomPeriod key={`${range.fromDate}|${range.toDate}`} range={range} today={today} onPick={onPick} />
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function CustomPeriod({
  range,
  today,
  onPick,
}: {
  range: ReportRange;
  today: string;
  onPick: (r: ReportRange) => void;
}) {
  const [from, setFrom] = useState(range.fromDate);
  const [to, setTo] = useState(range.toDate);
  const [problem, setProblem] = useState<string | null>(null);
  const input = "mt-0.5 block h-8 px-2 rounded-md border border-slate-300 bg-white text-sm text-slate-900";
  return (
    <form
      className="flex flex-wrap items-end gap-2 sm:ml-3"
      aria-label="Custom period"
      onSubmit={(e) => {
        e.preventDefault();
        const r = { fromDate: from, toDate: to };
        const p = rangeProblem(r);
        setProblem(p);
        if (!p) onPick(r);
      }}
    >
      <label className="text-xs text-slate-500">
        From
        <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} className={input} />
      </label>
      <label className="text-xs text-slate-500">
        To
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} />
      </label>
      <Button type="submit" size="sm" variant="secondary">
        Show
      </Button>
      {problem && (
        <p role="alert" className="basis-full text-sm text-red-700">
          {problem}
        </p>
      )}
    </form>
  );
}
