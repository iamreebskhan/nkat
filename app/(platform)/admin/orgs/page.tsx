/**
 * /admin/orgs — platform_admin cross-tenant view.
 *
 * Source: pallio_complete_vision_v3 §6.10. Mark's view of every
 * org on the platform with denial / volume rollups.
 */
"use client";

import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import type { AdminOrgRow } from "@/lib/features/admin/admin.service";

export default function PlatformOrgsPage() {
  const [rows, setRows] = useState<AdminOrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/orgs")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed.");
          return;
        }
        setRows(d.data.rows ?? []);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Organizations</h1>
        <p className="text-slate-600 mt-1">
          {rows.length} org{rows.length === 1 ? "" : "s"} on the platform.
        </p>
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      {!loading && rows.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Org</th>
                  <th className="text-right font-semibold px-4 py-2.5">Members</th>
                  <th className="text-right font-semibold px-4 py-2.5">Patients</th>
                  <th className="text-right font-semibold px-4 py-2.5">Visits</th>
                  <th className="text-right font-semibold px-4 py-2.5">Superbills</th>
                  <th className="text-right font-semibold px-4 py-2.5">Denials</th>
                  <th className="text-right font-semibold px-4 py-2.5">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <div className="font-medium">{o.name}</div>
                      <div className="text-xs text-slate-500 font-mono">{o.slug}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular">{o.memberCount}</td>
                    <td className="px-4 py-2 text-right tabular">{o.patientCount}</td>
                    <td className="px-4 py-2 text-right tabular">{o.visitCount}</td>
                    <td className="px-4 py-2 text-right tabular">{o.superbillCount}</td>
                    <td className="px-4 py-2 text-right tabular">{o.denialCount}</td>
                    <td className="px-4 py-2 text-right text-xs text-slate-500 tabular">
                      {o.createdAt.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
