/**
 * /payers/attestations — analyst attestation queue + active attestations.
 *
 * Source: pallio_complete_vision_v3 §15.3 (analyst workflow).
 *
 * Two tabs:
 *   - Queue: gaps surfaced by the lookup engine.
 *   - Active: confirmed attestations with freshness buckets.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  groupByFreshness,
  daysUntilExpiry,
  type AttestationFreshness,
} from "@/lib/features/attestations/attestation-pure";
import type {
  AttestationRequestView,
  AttestationView,
} from "@/lib/features/attestations/attestation.types";

type Tab = "queue" | "active";

export default function AttestationsPage() {
  const [tab, setTab] = useState<Tab>("queue");
  const [queue, setQueue] = useState<AttestationRequestView[]>([]);
  const [active, setActive] = useState<AttestationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      setLoading(true);
      try {
        const [qr, ar] = await Promise.all([
          fetch("/api/attestations/requests?status=open").then((r) => r.json()),
          fetch("/api/attestations?status=active&limit=200").then((r) => r.json()),
        ]);
        if (abandoned) return;
        if (!qr.success || !ar.success) {
          setError(qr.error ?? ar.error ?? "Failed to load.");
          return;
        }
        setQueue(qr.data.rows ?? []);
        setActive(ar.data.rows ?? []);
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

  const today = useMemo(() => new Date(), []);
  const grouped = useMemo(
    () => groupByFreshness(active.map((a) => ({ status: a.status, expiresAt: a.expiresAt })), today),
    [active, today],
  );

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Attestations</h1>
          <p className="text-slate-600 mt-1">
            {queue.length} open · {active.length} active · {grouped.due.length} due ·{" "}
            {grouped.overdue.length} overdue
          </p>
        </div>
        <Link href="/payers/attestations/new">
          <Button>Log payer call</Button>
        </Link>
      </header>

      <div className="flex gap-2 mb-4 border-b border-slate-200">
        {(["queue", "active"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t
                ? "border-[var(--color-brand-700)] text-[var(--color-brand-700)]"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {t === "queue" ? "Queue" : "Active"}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50 mb-4 rounded">
          {error}
        </div>
      )}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      {!loading && tab === "queue" && (
        <Card>
          <CardContent className="p-0">
            {queue.length === 0 ? (
              <div className="px-4 py-12 text-center text-slate-500">
                Queue empty — every rule is sourced.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-semibold px-4 py-2.5">CPT</th>
                    <th className="text-left font-semibold px-4 py-2.5">Attribute</th>
                    <th className="text-left font-semibold px-4 py-2.5">State</th>
                    <th className="text-left font-semibold px-4 py-2.5">Source query</th>
                    <th className="text-right font-semibold px-4 py-2.5">Opened</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {queue.map((q) => (
                    <tr key={q.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 font-mono">{q.cptCode}</td>
                      <td className="px-4 py-2 text-slate-700">{q.attribute.replace(/_/g, " ")}</td>
                      <td className="px-4 py-2">{q.state ?? "—"}</td>
                      <td className="px-4 py-2 text-slate-600 max-w-md truncate" title={q.sourceQuery ?? ""}>
                        {q.sourceQuery ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-500 text-xs">
                        {q.createdAt.slice(0, 10)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          href={`/payers/attestations/new?requestId=${q.id}&cptCode=${q.cptCode}&attribute=${q.attribute}${q.state ? `&state=${q.state}` : ""}`}
                          className="text-xs text-[var(--color-brand-700)] hover:underline"
                        >
                          Claim →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {!loading && tab === "active" && (
        <Card>
          <CardContent className="p-0">
            {active.length === 0 ? (
              <div className="px-4 py-12 text-center text-slate-500">
                No active attestations yet. Log a payer call to begin.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-semibold px-4 py-2.5">CPT</th>
                    <th className="text-left font-semibold px-4 py-2.5">State</th>
                    <th className="text-left font-semibold px-4 py-2.5">Attribute</th>
                    <th className="text-left font-semibold px-4 py-2.5">Coverage</th>
                    <th className="text-left font-semibold px-4 py-2.5">Rep</th>
                    <th className="text-right font-semibold px-4 py-2.5">Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {active.map((a) => {
                    const days = daysUntilExpiry(a.expiresAt, today);
                    const bucket = bucketFor(a.status, days);
                    return (
                      <tr key={a.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2 font-mono">{a.cptCode}</td>
                        <td className="px-4 py-2">{a.state}</td>
                        <td className="px-4 py-2 text-slate-700">
                          {a.attribute.replace(/_/g, " ")}
                        </td>
                        <td className="px-4 py-2">
                          <CoverageStatusPill status={a.coverageStatus} />
                        </td>
                        <td className="px-4 py-2 text-slate-700">{a.payerRepName}</td>
                        <td className="px-4 py-2 text-right">
                          <FreshnessPill bucket={bucket} days={days} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function bucketFor(status: string, days: number): AttestationFreshness {
  if (status !== "active") return "overdue";
  if (days < 0) return "overdue";
  if (days <= 7) return "due";
  if (days <= 30) return "expiring_soon";
  return "fresh";
}

function FreshnessPill({ bucket, days }: { bucket: AttestationFreshness; days: number }) {
  const map: Record<AttestationFreshness, { cls: string; label: string }> = {
    fresh: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20", label: `${days}d` },
    expiring_soon: { cls: "bg-amber-50 text-amber-800 ring-amber-600/30", label: `${days}d` },
    due: { cls: "bg-orange-100 text-orange-800 ring-orange-600/30", label: `${days}d` },
    overdue: { cls: "bg-red-100 text-red-800 ring-red-600/30", label: "Overdue" },
  };
  const m = map[bucket];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${m.cls}`}>
      {m.label}
    </span>
  );
}

function CoverageStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    covered: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
    not_covered: "bg-red-50 text-red-800 ring-red-600/30",
    varies: "bg-amber-50 text-amber-800 ring-amber-600/30",
    unknown: "bg-slate-100 text-slate-700 ring-slate-600/20",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${map[status] ?? map.unknown}`}>
      {status.replace("_", " ")}
    </span>
  );
}
