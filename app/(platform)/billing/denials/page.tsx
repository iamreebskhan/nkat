/**
 * /billing/denials — list + filter view.
 *
 * Source: pallio_complete_vision_v3 §6.5 (denial management).
 *
 * Filterable by decision (pending / refile / write_off / appeal) so
 * the billing agent can triage. "Log denial" CTA top-right.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeDenialMetrics, lookupCarc } from "@/lib/features/denials/denial-pure";
import {
  DENIAL_DECISIONS,
  type DenialDecision,
  type DenialView,
} from "@/lib/features/denials/denial.types";

export default function DenialsPage() {
  const [rows, setRows] = useState<DenialView[]>([]);
  const [decision, setDecision] = useState<DenialDecision | "all">("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (decision !== "all") params.set("decision", decision);
        const r = await fetch(`/api/denials?${params.toString()}`);
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setError(data.error ?? "Failed to load.");
          setRows([]);
          return;
        }
        setRows(data.data.rows ?? []);
      } catch {
        if (!abandoned) setError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [decision]);

  const metrics = useMemo(
    () =>
      computeDenialMetrics(
        rows.map((r) => ({
          carcCode: r.carcCode,
          payerId: r.payerId,
          deniedAmountCents: r.deniedAmountCents,
          decision: r.decision,
        })),
      ),
    [rows],
  );

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Denials</h1>
          <p className="text-slate-600 mt-1">
            {metrics.total} denial{metrics.total === 1 ? "" : "s"} ·{" "}
            <span className="tabular">
              ${(metrics.totalDeniedCents / 100).toFixed(2)}
            </span>{" "}
            denied
          </p>
        </div>
        <Link href="/billing/denials/log">
          <Button>Log denial</Button>
        </Link>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <KPICard label="Pending decisions" value={metrics.pendingDecisions.toString()} />
        <KPICard
          label="Top CARC"
          value={metrics.byCarc[0] ? `${metrics.byCarc[0].carc} · ${metrics.byCarc[0].count}×` : "—"}
        />
        <KPICard
          label="Top payer impact"
          value={
            metrics.byPayerId[0]
              ? `$${(metrics.byPayerId[0].deniedCents / 100).toFixed(2)}`
              : "—"
          }
        />
      </div>

      <Card>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
          <span className="text-sm text-slate-600">Decision:</span>
          {(["all", ...DENIAL_DECISIONS] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDecision(d)}
              className={`px-3 py-1 rounded text-xs ${
                decision === d
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {d.replace("_", " ")}
            </button>
          ))}
        </div>
        <CardContent className="p-0">
          {error && (
            <div role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">
              {error}
            </div>
          )}
          {loading && <div className="px-4 py-3 text-sm text-slate-500">Loading…</div>}
          {!loading && rows.length === 0 && (
            <div className="px-4 py-12 text-center text-slate-500">
              No denials match the filter.{" "}
              <Link href="/billing/denials/log" className="text-[var(--color-brand-700)] underline">
                Log one
              </Link>
              .
            </div>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Date</th>
                  <th className="text-left font-semibold px-4 py-2.5">CPT</th>
                  <th className="text-left font-semibold px-4 py-2.5">CARC</th>
                  <th className="text-left font-semibold px-4 py-2.5">Reason</th>
                  <th className="text-right font-semibold px-4 py-2.5">Denied</th>
                  <th className="text-left font-semibold px-4 py-2.5">Decision</th>
                  <th className="font-semibold px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((d) => {
                  const carc = lookupCarc(d.carcCode);
                  return (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 tabular text-slate-700">
                        {d.deniedAt.slice(0, 10)}
                      </td>
                      <td className="px-4 py-2 font-mono tabular text-slate-700">
                        {d.cptCode}
                      </td>
                      <td className="px-4 py-2 font-mono tabular text-slate-700">
                        {d.carcCode}
                      </td>
                      <td className="px-4 py-2 text-slate-600 max-w-md truncate" title={carc.text}>
                        {d.denialReason ?? carc.text}
                      </td>
                      <td className="px-4 py-2 text-right tabular font-medium">
                        ${(d.deniedAmountCents / 100).toFixed(2)}
                      </td>
                      <td className="px-4 py-2">
                        <DecisionPill decision={d.decision} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          href={`/billing/denials/${d.id}`}
                          className="text-xs text-[var(--color-brand-700)] hover:underline"
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KPICard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-slate-500 font-normal">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular text-slate-900">{value}</div>
      </CardContent>
    </Card>
  );
}

function DecisionPill({ decision }: { decision: DenialDecision }) {
  const map: Record<DenialDecision, { cls: string; label: string }> = {
    pending: { cls: "bg-amber-50 text-amber-800 ring-amber-600/30", label: "Pending" },
    refile: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20", label: "Refile" },
    write_off: { cls: "bg-slate-100 text-slate-700 ring-slate-600/20", label: "Write-off" },
    appeal: { cls: "bg-blue-50 text-blue-800 ring-blue-600/20", label: "Appeal" },
  };
  const m = map[decision];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
