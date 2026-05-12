/** /billing/superbills — superbill queue + status filters. */
"use client";

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface SuperbillRow {
  id: string;
  status: string;
  dateOfService: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
}

const STATUSES = ["all", "draft", "submitted", "paid", "partially_paid", "denied", "voided"] as const;

export default function SuperbillsPage() {
  const [rows, setRows] = useState<SuperbillRow[]>([]);
  const [filter, setFilter] = useState<typeof STATUSES[number]>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/superbills")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed.");
          return;
        }
        setRows(d.data?.rows ?? []);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Superbills</h1>
        <p className="text-slate-600 mt-1">
          Generate from a documented visit on the visit page. Track + edit before submission.
        </p>
      </header>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle>Queue</CardTitle>
            <div className="flex gap-1 flex-wrap">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilter(s)}
                  className={`px-3 py-1 rounded text-xs ${
                    filter === s
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {s.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>
          <CardDescription>{visible.length} superbill{visible.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">{error}</p>
          )}
          {loading && <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>}
          {!loading && visible.length === 0 && !error && (
            <p className="px-4 py-12 text-center text-sm text-slate-500">No superbills match this filter.</p>
          )}
          {visible.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">DOS</th>
                  <th className="text-left font-semibold px-4 py-2.5">Status</th>
                  <th className="text-right font-semibold px-4 py-2.5">Billed</th>
                  <th className="text-right font-semibold px-4 py-2.5">Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 tabular text-slate-700">{s.dateOfService.slice(0, 10)}</td>
                    <td className="px-4 py-2 text-xs">{s.status.replace("_", " ")}</td>
                    <td className="px-4 py-2 text-right tabular">${(s.billedAmountCents / 100).toFixed(2)}</td>
                    <td className="px-4 py-2 text-right tabular">
                      {s.paidAmountCents == null ? "—" : `$${(s.paidAmountCents / 100).toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
