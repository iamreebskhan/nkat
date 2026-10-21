/**
 * A patient's vitals over time — the most recent page of them, said as such.
 *
 * This is the half of Mark's ask a field on the note can never satisfy:
 * [06:29] "you're going to collect their vitals, KEEP TRACK of their vitals,
 * their weight, all of those things." Collection was built; keeping track was
 * an API with no screen, which is the same as not having it.
 *
 * Weight leads because weight loss is THE palliative trajectory signal — his
 * own sample note carries it as prose ("recent weight loss", a patient with
 * cachexia), which no one can query or chart. Here it is a series, and the
 * change across the readings shown is computed rather than typed.
 *
 * Everything renders in US customary units through the shared field spec, so
 * this screen and the note entry form can never disagree about what a number
 * means.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  VITALS_FIELDS,
  kgToLb,
  showStored,
  type VitalsFieldSpec,
} from "@/lib/features/visits/vitals-units";

interface TrendRow {
  visitId: string;
  /** When the patient was SEEN — what a clinical trend is plotted against. */
  dateOfService: string | null;
  /** When the numbers were typed in. Deliberately not the axis. */
  recordedAt: string | null;
  heightCm: number | null;
  weightKg: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  respRate: number | null;
  temperatureC: number | null;
  spo2Percent: number | null;
  ppsPercent: number | null;
  painScore: number | null;
  notes: string | null;
}

/** The columns worth a table cell, in the order a clinician scans them. */
const COLUMNS = ["weightKg", "ppsPercent", "painScore", "bpSystolic", "heartRate", "respRate", "temperatureC", "spo2Percent"];

const spec = (key: string): VitalsFieldSpec => VITALS_FIELDS.find((f) => f.key === key)!;

export function VitalsTrend({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<TrendRow[] | null>(null);
  /**
   * Every visit with vitals on file, which is not always how many came back:
   * the service returns newest-first and caps the page. This is what lets the
   * card say "Latest 200 of 206" instead of calling a page the whole record.
   */
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      const r = await fetch(`/api/patients/${patientId}/vitals`).catch(() => null);
      if (!r || abandoned) return;
      const d = await r.json().catch(() => null);
      if (!d || abandoned) return;
      if (!d.success) {
        setError(d.error ?? "Could not load the vitals history.");
        return;
      }
      setRows((d.data.trend ?? []) as TrendRow[]);
      setTotal(Number(d.data.total ?? 0));
    })();
    return () => {
      abandoned = true;
    };
  }, [patientId]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }
  if (!rows) return <p className="text-sm text-slate-500">Loading vitals…</p>;

  // The service returns newest first. Weights are read oldest-to-newest so the
  // change reads the way a clinician says it: "down 32 lb since June".
  const weighed = rows.filter((r) => r.weightKg !== null);
  const latest = weighed[0];
  const earliest = weighed[weighed.length - 1];
  const deltaLb =
    latest && earliest && latest !== earliest
      ? kgToLb(latest.weightKg!) - kgToLb(earliest.weightKg!)
      : null;
  const capped = total > rows.length;
  // The delta above is measured from the oldest row ON THE PAGE. When the page
  // is capped that is not the patient's first reading, so the number is true
  // and still smaller than the real loss — "Down 12 lb since March" on a chart
  // whose record starts at 160 lb. The words have to carry which one it is,
  // or a partial figure reads as the whole trajectory (audit R34).
  const sinceDate = (earliest?.dateOfService ?? "").slice(0, 10);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vitals over time</CardTitle>
        {/* When the page is capped, say so and say what it is a page OF. The
            rows that fall off a newest-first cap are the oldest ones — the
            baseline the weight change above is measured from — so a count
            that reads as the whole record is the one wrong thing this card
            could say (audit R34). */}
        <CardDescription>
          {rows.length === 0
            ? "No vitals recorded yet."
            : total > rows.length
              ? `Latest ${rows.length} of ${total} visits with recorded vitals, newest first.`
              : `${rows.length} visit${rows.length === 1 ? "" : "s"} with recorded vitals, newest first.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            Vitals recorded on a visit note appear here, so weight and performance status
            can be read as a trend rather than one visit at a time.
          </p>
        ) : (
          <>
            {latest && (
              <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="text-sm text-slate-600">
                  Latest weight{" "}
                  <strong className="text-slate-900 tabular">
                    {showStored(spec("weightKg"), latest.weightKg)} lb
                  </strong>
                </span>
                {deltaLb !== null && Math.abs(deltaLb) >= 0.1 && (
                  <span
                    className={`text-sm tabular ${deltaLb < 0 ? "text-amber-800" : "text-slate-600"}`}
                  >
                    {deltaLb < 0 ? "Down" : "Up"}{" "}
                    <strong>{Math.abs(Math.round(deltaLb * 10) / 10)} lb</strong> since{" "}
                    {sinceDate || "the oldest reading shown"}
                    {capped && " — the oldest on this page, not the first on file"}
                  </span>
                )}
                {latest.ppsPercent !== null && (
                  <span className="text-sm text-slate-600">
                    PPS <strong className="text-slate-900 tabular">{latest.ppsPercent}%</strong>
                  </span>
                )}
              </div>
            )}

            {/* Wide on purpose — it scrolls inside the card rather than
                pushing the page sideways on a tablet. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 font-medium">Date</th>
                    {COLUMNS.map((key) => (
                      <th key={key} className="px-3 py-2 font-medium whitespace-nowrap">
                        {spec(key).label}
                        {spec(key).unit && (
                          <span className="text-slate-400 normal-case"> {spec(key).unit}</span>
                        )}
                      </th>
                    ))}
                    <th className="px-3 py-2 font-medium">Visit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.visitId}>
                      <td className="px-3 py-2 tabular whitespace-nowrap">
                        {(r.dateOfService ?? "").slice(0, 10) || "—"}
                      </td>
                      {COLUMNS.map((key) => (
                        <td key={key} className="px-3 py-2 tabular">
                          {showStored(spec(key), r[key as keyof TrendRow] as number | null)}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <Link
                          href={`/visits/${r.visitId}/document`}
                          className="text-xs text-[var(--color-brand-700)] hover:underline"
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
