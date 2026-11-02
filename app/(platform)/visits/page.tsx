/**
 * /visits — clinician default landing.
 *
 * Source: pallio_complete_vision_v3 §7.1.
 *
 * Lists the clinician's recent + upcoming visits with quick-open
 * links. The §7.2 mobile field-doc experience (offline banner +
 * sync icons) lands in a follow-up phase since it requires service
 * worker work.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { VisitView } from "@/lib/features/visits/visit.types";

export default function VisitsPage() {
  const [visits, setVisits] = useState<VisitView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch("/api/visits?limit=100");
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

  const buckets = useMemo(() => bucketize(visits), [visits]);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Visits</h1>
        <p className="text-slate-600 mt-1">
          Your visits, ordered by status. Tap to document.
        </p>
      </header>

      {loading && <p className="text-slate-500">Loading…</p>}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}

      {!loading && !error && visits.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No visits assigned</CardTitle>
            <CardDescription>
              Once an org admin schedules visits, they appear here.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="space-y-4">
        {buckets.map(({ label, items, severity }) =>
          items.length === 0 ? null : (
            <Card key={label} severity={severity}>
              <CardHeader>
                <CardTitle>
                  {label}{" "}
                  <span className="text-slate-500 text-sm font-normal tabular">
                    ({items.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-slate-100">
                  {items.map((v) => (
                    <li
                      key={v.id}
                      className="py-2 flex items-center justify-between text-sm"
                    >
                      <div>
                        <span className="font-medium">{v.visitTypeLabel}</span>
                        <span className="text-slate-500 tabular">
                          {" · "}
                          {/* The practice's clock (VisitView.serviceAt). This
                              sliced the ISO string, which is UTC: an 8:30 pm
                              Ohio visit read as 00:30 the next day. A PCM/CCM
                              month (0117) has a date of service and no visit
                              time: its noon is only where the day is kept. */}
                          {v.codingBasis === "care_management"
                            ? `date of service ${v.serviceDay ?? "—"}`
                            : (v.serviceAt ?? v.serviceDay ?? "not scheduled")}
                        </span>
                        {OTHER_STATUS_WORDS[v.status] && (
                          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                            {OTHER_STATUS_WORDS[v.status]}
                          </span>
                        )}
                        <span className="text-slate-500"> · </span>
                        <Link
                          href={`/patients/${v.patientId}`}
                          className="text-xs text-slate-500 hover:underline"
                        >
                          {/* The row said the literal word "patient" for every
                              visit, so a clinician scanning the day's list
                              could not tell whose visit was whose without
                              opening each one. patientName is already on every
                              row the API returns; it was simply never read. */}
                          {v.patientName ?? "patient"}
                        </Link>
                      </div>
                      <Link
                        // A PCM/CCM month is read, never documented (0117).
                        href={`/visits/${v.id}/${v.codingBasis === "care_management" ? "view" : "document"}`}
                        className="text-xs text-[var(--color-brand-700)] hover:underline"
                      >
                        Open →
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The statuses the "Other" card holds, said on each row. A billed visit and a
 * cancelled one sat side by side with nothing to tell them apart, each with
 * the same "Open →".
 */
const OTHER_STATUS_WORDS: Partial<Record<VisitView["status"], string>> = {
  billed: "billed",
  cancelled: "cancelled",
  no_show: "no-show",
};

function bucketize(visits: VisitView[]): {
  label: string;
  items: VisitView[];
  severity?: "info" | "warn" | "success" | "error";
}[] {
  return [
    {
      label: "In progress",
      severity: "warn" as const,
      items: visits.filter((v) => v.status === "in_progress"),
    },
    {
      label: "Scheduled",
      items: visits.filter((v) => v.status === "scheduled"),
    },
    {
      label: "Documented",
      severity: "success" as const,
      items: visits.filter((v) => v.status === "documented"),
    },
    {
      label: "Pending billing",
      items: visits.filter((v) => v.status === "pending_billing"),
    },
    {
      label: "Other",
      items: visits.filter(
        (v) =>
          ![
            "in_progress",
            "scheduled",
            "documented",
            "pending_billing",
          ].includes(v.status),
      ),
    },
  ];
}
