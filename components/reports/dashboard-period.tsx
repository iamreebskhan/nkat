/**
 * The Dashboard's period (Level-1 doc:75), kept in its URL (?from=&to=) so a
 * view of a quarter can be bookmarked or sent. The page reads it on the
 * server; this only moves the URL.
 */
"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { PeriodPicker } from "@/components/reports/period-picker";
import type { ReportRange } from "@/lib/features/reports/report-range";

export function DashboardPeriod({
  range,
  today,
  error,
}: {
  range: ReportRange;
  today: string;
  error: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div aria-busy={pending || undefined}>
      <PeriodPicker
        range={range}
        today={today}
        error={error}
        onPick={(r) => startTransition(() => router.push(`/?from=${r.fromDate}&to=${r.toDate}`))}
      />
      {pending && <p className="mt-1 text-xs text-slate-400">Updating…</p>}
    </div>
  );
}
