/**
 * /audit — append-only audit log viewer.
 *
 * Source: pallio_complete_vision_v3 §15.1 (audit log retention).
 * Filterable by action, user, date range. Cursor-paginated.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AuditLogRow } from "@/lib/features/audit/audit.service";

export default function AuditPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ action: "", userEmail: "", fromDate: "", toDate: "" });

  async function load(reset: boolean) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.action) params.set("action", filters.action);
      if (filters.userEmail) params.set("userEmail", filters.userEmail);
      if (filters.fromDate) params.set("fromDate", filters.fromDate);
      if (filters.toDate) params.set("toDate", filters.toDate);
      if (!reset && nextCursor) params.set("cursor", nextCursor);
      const r = await fetch(`/api/audit?${params.toString()}`);
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Failed.");
        return;
      }
      setRows(reset ? d.data.rows : [...rows, ...d.data.rows]);
      setNextCursor(d.data.nextCursor);
    } catch {
      // Without this, a thrown fetch left `loading` stuck true and the
      // Apply / Load-more buttons permanently disabled.
      setError("Network error — try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
    // intentionally fires only on mount; user submits filters via the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Audit log</h1>
        <p className="text-slate-600 mt-1">
          Append-only. Rows under 6 years old cannot be deleted.
        </p>
      </header>

      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <FilterField label="Action prefix" value={filters.action}
              onChange={(v) => setFilters({ ...filters, action: v })} placeholder="login, finalize_…" />
            <FilterField label="User email" value={filters.userEmail}
              onChange={(v) => setFilters({ ...filters, userEmail: v })} placeholder="user@org" />
            <FilterField label="From" type="date" value={filters.fromDate}
              onChange={(v) => setFilters({ ...filters, fromDate: v })} />
            <FilterField label="To" type="date" value={filters.toDate}
              onChange={(v) => setFilters({ ...filters, toDate: v })} />
            <Button onClick={() => load(true)} disabled={loading} size="sm">
              {loading ? "Loading…" : "Apply"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 && !loading ? (
            <div className="px-4 py-12 text-center text-slate-500">No audit rows.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">When</th>
                  <th className="text-left font-semibold px-4 py-2.5">User</th>
                  <th className="text-left font-semibold px-4 py-2.5">Action</th>
                  <th className="text-left font-semibold px-4 py-2.5">Target</th>
                  <th className="text-left font-semibold px-4 py-2.5">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 tabular text-slate-700 text-xs">
                      {r.occurredAt.replace("T", " ").slice(0, 19)}Z
                    </td>
                    <td className="px-4 py-2 text-slate-700 text-xs">{r.userEmail ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.action}</td>
                    <td className="px-4 py-2 text-slate-600 text-xs">
                      {r.targetType ?? "—"}
                      {r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ""}
                    </td>
                    <td className="px-4 py-2 text-slate-500 text-xs tabular">{r.ipAddress ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => load(false)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-700 mb-1">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
      />
    </label>
  );
}
