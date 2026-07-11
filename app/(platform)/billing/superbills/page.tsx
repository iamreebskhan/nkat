/** /billing/superbills — superbill queue + status filters + transitions. */
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

const STATUSES = ["all", "draft", "ready_to_submit", "submitted", "paid", "partially_paid", "denied", "voided"] as const;

/**
 * Next-step actions per status — the day-to-day subset of the service's
 * transition map ("voided" is deliberately not a one-click button; it stays
 * API-only so the crawler and a stray click can't void a claim).
 */
const ACTIONS: Record<string, { label: string; to: string; amount?: "billed" | "prompt" }[]> = {
  draft: [{ label: "Mark submitted", to: "submitted" }],
  ready_to_submit: [{ label: "Mark submitted", to: "submitted" }],
  submitted: [
    { label: "Paid in full", to: "paid", amount: "billed" },
    { label: "Partially paid", to: "partially_paid", amount: "prompt" },
    { label: "Denied", to: "denied" },
  ],
  partially_paid: [{ label: "Paid in full", to: "paid", amount: "billed" }],
  denied: [{ label: "Resubmitted", to: "submitted" }],
};

export default function SuperbillsPage() {
  const [rows, setRows] = useState<SuperbillRow[]>([]);
  const [filter, setFilter] = useState<typeof STATUSES[number]>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load(): Promise<void> {
    return fetch("/api/superbills")
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
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function transition(row: SuperbillRow, action: { label: string; to: string; amount?: "billed" | "prompt" }) {
    let paidAmountCents: number | undefined;
    if (action.amount === "billed") paidAmountCents = row.billedAmountCents;
    if (action.amount === "prompt") {
      const v = prompt(`Amount paid (of $${(row.billedAmountCents / 100).toFixed(2)} billed):`, "");
      if (v === null || v.trim() === "") return; // cancelled / empty ≠ $0.00
      const dollars = Number(v.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(dollars) || dollars < 0) {
        alert("Enter a valid dollar amount.");
        return;
      }
      paidAmountCents = Math.round(dollars * 100);
    }
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/superbills/${row.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: action.to, ...(paidAmountCents !== undefined ? { paidAmountCents } : {}) }),
      });
      const d = await r.json();
      if (!d.success) alert(d.error ?? "Transition failed.");
      else await load(); // keep the row's buttons disabled until the fresh status renders
    } catch {
      alert("Network error — status not changed.");
    } finally {
      setBusyId(null);
    }
  }

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
                  <th className="text-right font-semibold px-4 py-2.5">Actions</th>
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
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1.5 flex-wrap">
                        {(ACTIONS[s.status] ?? []).map((a) => (
                          <button
                            key={a.to + a.label}
                            type="button"
                            disabled={busyId === s.id}
                            onClick={() => void transition(s, a)}
                            className="px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
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
