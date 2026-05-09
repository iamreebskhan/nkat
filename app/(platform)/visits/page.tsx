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

      {!loading && visits.length === 0 && (
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
                        <span className="font-medium">
                          {v.visitType.replace(/_/g, " ")}
                        </span>
                        <span className="text-slate-500 tabular">
                          {" · "}
                          {(
                            v.scheduledStart ??
                            v.startTime ??
                            v.createdAt
                          ).slice(0, 16).replace("T", " ")}
                        </span>
                        <span className="text-slate-500"> · </span>
                        <Link
                          href={`/patients/${v.patientId}`}
                          className="text-xs text-slate-500 hover:underline"
                        >
                          patient
                        </Link>
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
          ),
        )}
      </div>
    </div>
  );
}

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
