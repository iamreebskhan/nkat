/**
 * /schedule/print?date=YYYY-MM-DD — printable day route sheet.
 *
 * Palliative-care nurses drive between homes; this is the day's visits
 * in time order with patient + town, formatted for a clean print. Opens
 * the browser print dialog on load.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import { orgClockTime, orgLocalDate } from "@/lib/features/org/org-date";
import { usePracticeZone } from "@/lib/features/schedule/use-practice-zone";
import type { VisitView } from "@/lib/features/visits/visit.types";

export default function PrintRoutePage() {
  // The route runs on the practice's clock, as the board it is printed from.
  const zone = usePracticeZone();
  const tz = zone?.timeZone;
  const practiceToday = zone?.today;
  // ?date=YYYY-MM-DD read client-side (below), defaulting to today. Avoiding
  // useSearchParams keeps this off a Suspense boundary that can stall on a cold
  // load — relevant here because the page is opened in a fresh tab to print.
  //
  // Null until the browser decides it. The server used to compute "today" as
  // well, as a UTC date, and render it through toLocaleDateString in its own
  // locale: the server's text never matched the browser's (a hydration error
  // on every load), and after 8 pm in Ohio the default day was tomorrow.
  const [date, setDate] = useState<string | null>(null);
  const [visits, setVisits] = useState<VisitView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!practiceToday) return;
    // From a timer, so the date isn't set synchronously in the effect body.
    const t = setTimeout(() => {
      const d = new URLSearchParams(window.location.search).get("date");
      setDate(d || practiceToday);
    }, 0);
    return () => clearTimeout(t);
  }, [practiceToday]);

  useEffect(() => {
    fetch("/api/visits?status=scheduled&limit=200")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setVisits(d.data.rows ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  const dayVisits = useMemo(
    () =>
      visits
        // The visit's day where the practice is, not its UTC day: a 9 pm visit
        // is stored as the next morning in UTC.
        .filter((v) => {
          const at = v.scheduledStart ?? v.startTime;
          return date !== null && at != null && !!tz && orgLocalDate(at, tz) === date;
        })
        .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? "")),
    [visits, date, tz],
  );

  useEffect(() => {
    if (!loading && dayVisits.length > 0) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [loading, dayVisits.length]);

  const pretty =
    date === null
      ? null
      : new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        });

  return (
    <div className="px-8 py-8 max-w-2xl mx-auto print:px-0">
      <h1 className="text-2xl font-bold">Route sheet{pretty ? ` — ${pretty}` : ""}</h1>
      <p className="text-slate-500 text-sm mb-4">
        {dayVisits.length} visit{dayVisits.length === 1 ? "" : "s"}
      </p>
      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : dayVisits.length === 0 ? (
        <p className="text-slate-500">No visits scheduled for this day.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-slate-300 text-left">
              <th className="py-2 pr-3">Time</th>
              <th className="py-2 pr-3">Patient</th>
              <th className="py-2 pr-3">Town</th>
              <th className="py-2 pr-3">Visit</th>
              <th className="py-2">Clinician</th>
            </tr>
          </thead>
          <tbody>
            {dayVisits.map((v) => (
              <tr key={v.id} className="border-b border-slate-200">
                <td className="py-2 pr-3 tabular">{tz ? timeOf(v.scheduledStart ?? v.startTime, tz) : "—"}</td>
                <td className="py-2 pr-3">{v.patientName ?? "—"}</td>
                <td className="py-2 pr-3">{v.patientCity ?? "—"}</td>
                <td className="py-2 pr-3">{v.visitType.replace(/_/g, " ")}{v.isTelehealth ? " (telehealth)" : ""}</td>
                <td className="py-2">{v.clinicianName ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function timeOf(iso: string | null, tz: string): string {
  return iso ? orgClockTime(iso, tz) : "—";
}
