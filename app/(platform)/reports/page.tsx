/**
 * /reports — operational dashboard.
 *
 * Source: pallio_complete_vision_v3 §6.6.
 *
 * Five charts: denial-rate trend, denials by payer, revenue summary,
 * visit volume by clinician, rule coverage %.
 */
"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReportsOverview } from "@/lib/features/reports/reports.service";

export default function ReportsPage() {
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/reports/overview")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed.");
          return;
        }
        setData(d.data);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="px-8 py-8 text-sm text-slate-500">Loading reports…</div>;
  }
  if (error || !data) {
    return (
      <div className="px-8 py-8">
        <div className="text-sm text-red-700 bg-red-50 rounded px-3 py-2">{error}</div>
      </div>
    );
  }

  const peakDenialRate = Math.max(0, ...data.denialRateTrend.map((p) => p.value));

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Reports</h1>
        <p className="text-slate-600 mt-1">
          {data.range.fromDate} → {data.range.toDate}
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <KPI label="Billed" value={`$${(data.revenue.billedCents / 100).toFixed(0)}`} />
        <KPI label="Collected" value={`$${(data.revenue.paidCents / 100).toFixed(0)}`} />
        <KPI label="Outstanding" value={`$${(data.revenue.outstandingCents / 100).toFixed(0)}`} />
        <KPI
          label="Collection rate"
          value={`${(data.revenue.collectionRate * 100).toFixed(1)}%`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Denial-rate trend</CardTitle>
          </CardHeader>
          <CardContent>
            {data.denialRateTrend.length === 0 ? (
              <Empty />
            ) : (
              <div className="flex items-end gap-1 h-40">
                {data.denialRateTrend.map((p) => (
                  <div
                    key={p.date}
                    className="flex-1 bg-[var(--color-brand-600)]/80 hover:bg-[var(--color-brand-700)] transition-colors rounded-t"
                    style={{
                      height: `${peakDenialRate > 0 ? (p.value / peakDenialRate) * 100 : 0}%`,
                      minHeight: p.value > 0 ? "2px" : "0",
                    }}
                    title={`${p.date}: ${p.value}%`}
                  />
                ))}
              </div>
            )}
            <div className="flex justify-between text-xs text-slate-500 mt-2 tabular">
              <span>{data.denialRateTrend[0]?.date.slice(5) ?? ""}</span>
              <span>peak {peakDenialRate.toFixed(1)}%</span>
              <span>{data.denialRateTrend[data.denialRateTrend.length - 1]?.date.slice(5) ?? ""}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Denials by payer</CardTitle>
          </CardHeader>
          <CardContent>
            {data.denialsByPayer.length === 0 ? (
              <Empty />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-semibold py-1">Payer</th>
                    <th className="text-right font-semibold py-1">Count</th>
                    <th className="text-right font-semibold py-1">$ denied</th>
                    <th className="text-right font-semibold py-1">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.denialsByPayer.slice(0, 8).map((p) => (
                    <tr key={p.payerId ?? "null"}>
                      <td className="py-2 text-slate-700">{p.payerId?.slice(0, 8) ?? "—"}</td>
                      <td className="py-2 text-right tabular">{p.count}</td>
                      <td className="py-2 text-right tabular font-medium">
                        ${(p.deniedCents / 100).toFixed(0)}
                      </td>
                      <td className="py-2 text-right tabular">
                        {(p.rate * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Visit volume by clinician</CardTitle>
          </CardHeader>
          <CardContent>
            {data.visitVolume.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-2">
                {data.visitVolume.slice(0, 8).map((v) => (
                  <li key={v.clinicianUserId} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{v.clinicianUserId.slice(0, 8)}</span>
                    <span className="tabular font-medium">{v.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rule coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular text-slate-900">
              {(data.ruleCoverage.coverageRate * 100).toFixed(1)}%
            </div>
            <p className="text-xs text-slate-500 mt-1 tabular">
              {data.ruleCoverage.confirmed} confirmed · {data.ruleCoverage.unknown} unknown ·{" "}
              {data.ruleCoverage.total} total
            </p>
            <div className="mt-4 h-2 bg-slate-100 rounded overflow-hidden">
              <div
                className="h-full bg-[var(--color-brand-600)]"
                style={{ width: `${data.ruleCoverage.coverageRate * 100}%` }}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KPI({ label, value }: { label: string; value: string }) {
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

function Empty() {
  return <p className="text-sm text-slate-500 py-8 text-center">No data in range.</p>;
}
