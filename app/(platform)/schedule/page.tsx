/**
 * /schedule — week-view calendar of upcoming + recent visits.
 *
 * Source: pallio_complete_vision_v3 §6.3 (scheduling).
 *
 * Rather than pull a heavyweight calendar lib, this MVP renders a
 * grouped-by-day list. Phase 4 swaps in a true week grid (recurring
 * visit templates + drag-to-reschedule).
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { VisitView } from "@/lib/features/visits/visit.types";

export default function SchedulePage() {
  const [visits, setVisits] = useState<VisitView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch("/api/visits?status=scheduled&limit=200");
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setError(data.error ?? "Failed to load.");
          return;
        }
        setVisits(data.data.rows ?? []);
      } catch {
        if (!abandoned) setError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, []);

  const grouped = useMemo(() => groupByDay(visits), [visits]);

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Schedule</h1>
          <p className="text-slate-600 mt-1">
            Upcoming visits across all clinicians.
          </p>
        </div>
        <Button>New visit (Phase 4)</Button>
      </header>

      {loading && <p className="text-slate-500">Loading…</p>}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {!loading && grouped.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No upcoming visits</CardTitle>
            <CardDescription>
              Schedule a visit from a patient record.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="space-y-4">
        {grouped.map(({ date, items }) => (
          <Card key={date}>
            <CardHeader>
              <CardTitle className="text-lg tabular">{prettyDate(date)}</CardTitle>
              <CardDescription>
                {items.length} visit{items.length === 1 ? "" : "s"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-slate-100">
                {items.map((v) => (
                  <li
                    key={v.id}
                    className="py-2 flex items-center justify-between text-sm"
                  >
                    <div>
                      <span className="font-medium">
                        {v.visitType.replace(/_/g, " ")}
                      </span>
                      <span className="text-slate-500 tabular">
                        {" · "}
                        {timeOf(v.scheduledStart ?? v.startTime)}
                      </span>
                      {v.isTelehealth && (
                        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                          telehealth
                        </span>
                      )}
                    </div>
                    <Link
                      href={`/visits/${v.id}/document`}
                      className="text-xs text-[var(--color-brand-700)] hover:underline"
                    >
                      Open →
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function groupByDay(visits: VisitView[]): { date: string; items: VisitView[] }[] {
  const map = new Map<string, VisitView[]>();
  for (const v of visits) {
    const ts = v.scheduledStart ?? v.startTime ?? v.createdAt;
    const day = ts.slice(0, 10);
    const arr = map.get(day) ?? [];
    arr.push(v);
    map.set(day, arr);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, items }));
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function timeOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
