/**
 * /schedule/print?date=YYYY-MM-DD — printable day route sheet.
 *
 * Palliative-care nurses drive between homes; this is the day's visits
 * in time order with patient + town, formatted for a clean print. Opens
 * the browser print dialog on load.
 *
 * A sheet that could not be filled says so and does not print. It used to read
 * "No visits scheduled for this day." after a failed load, and before that it
 * listed the day out of the newest 200 booked visits, so with repeating series
 * booked months ahead a full day printed as empty.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import { addDaysIso, orgClockTime, orgInstant, orgLocalDate } from "@/lib/features/org/org-date";
import { usePracticeZoneStatus } from "@/lib/features/schedule/use-practice-zone";
import type { VisitView } from "@/lib/features/visits/visit.types";

/** The most visits one day is read with: GET /api/visits's window limit. */
const DAY_LIMIT = 1000;

export default function PrintRoutePage() {
  // The route runs on the practice's clock, as the board it is printed from.
  const { zone, failed: zoneFailed } = usePracticeZoneStatus();
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
  // The day's visits, once read: null until then.
  const [visits, setVisits] = useState<VisitView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (!date || !tz) return;
    let abandoned = false;
    // The practice's day, start to end, asked for whole.
    let from: string;
    let to: string;
    try {
      from = orgInstant(`${date}T00:00`, tz).toISOString();
      to = orgInstant(`${addDaysIso(date, 1)}T00:00`, tz).toISOString();
    } catch {
      // From a timer, as the date above: not set synchronously in the effect.
      const t = setTimeout(() => setError(`"${date}" is not a day. Open the route sheet from the schedule.`), 0);
      return () => clearTimeout(t);
    }
    fetch(
      `/api/visits?status=scheduled&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${DAY_LIMIT}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (!d.success) {
          setError(d.error ?? "The day's visits could not be loaded.");
          return;
        }
        const rows: VisitView[] = d.data.rows ?? [];
        if (d.data.total > rows.length) {
          setError(`This day has ${d.data.total} booked visits, more than one sheet reads (${DAY_LIMIT}).`);
          return;
        }
        setVisits(rows);
      })
      .catch(() => {
        if (!abandoned) setError("Network error: the day's visits could not be loaded.");
      });
    return () => {
      abandoned = true;
    };
  }, [date, tz]);

  const dayVisits = useMemo(
    () =>
      (visits ?? [])
        // The visit's day where the practice is, not its UTC day: a 9 pm visit
        // is stored as the next morning in UTC.
        .filter((v) => {
          const at = v.scheduledStart ?? v.startTime;
          return date !== null && at != null && !!tz && orgLocalDate(at, tz) === date;
        })
        .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? "")),
    [visits, date, tz],
  );

  const failure = error ?? (zoneFailed ? "The practice's clock could not be read, so the day's visits cannot be listed." : null);
  const loaded = visits !== null && !failure;

  useEffect(() => {
    if (loaded && dayVisits.length > 0) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [loaded, dayVisits.length]);

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
      {loaded && (
        <p className="text-slate-500 text-sm mb-4">
          {dayVisits.length} visit{dayVisits.length === 1 ? "" : "s"}
        </p>
      )}
      {failure ? (
        <p role="alert" className="mt-4 text-red-700">
          {failure} Nothing was printed: reload to try again.
        </p>
      ) : !loaded ? (
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
