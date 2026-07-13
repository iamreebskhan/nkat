/**
 * /schedule/print?date=YYYY-MM-DD — printable day route sheet.
 *
 * Palliative-care nurses drive between homes; this is the day's visits
 * in time order with patient + town, formatted for a clean print. Opens
 * the browser print dialog on load.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import type { VisitView } from "@/lib/features/visits/visit.types";

export default function PrintRoutePage() {
  // ?date=YYYY-MM-DD read client-side (below), defaulting to today. Avoiding
  // useSearchParams keeps this off a Suspense boundary that can stall on a cold
  // load — relevant here because the page is opened in a fresh tab to print.
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [visits, setVisits] = useState<VisitView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("date");
    if (d) setDate(d);
  }, []);

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
        .filter((v) => (v.scheduledStart ?? v.startTime ?? "").slice(0, 10) === date)
        .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? "")),
    [visits, date],
  );

  useEffect(() => {
    if (!loading && dayVisits.length > 0) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [loading, dayVisits.length]);

  const pretty = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="px-8 py-8 max-w-2xl mx-auto print:px-0">
      <h1 className="text-2xl font-bold">Route sheet — {pretty}</h1>
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
                <td className="py-2 pr-3 tabular">{timeOf(v.scheduledStart ?? v.startTime)}</td>
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

function timeOf(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
