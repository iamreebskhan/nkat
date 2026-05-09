/**
 * /patients — list view.
 *
 * Source: pallio_complete_vision_v3 §6.2 + playbook §9.1 (density toggle).
 *
 * Searchable, status-filterable. New patient button top-right.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TextInput } from "@/components/forms/field";
import type { PatientStatus, PatientView } from "@/lib/features/patients/patient.types";

type Density = "compact" | "default" | "comfortable";

const DENSITY_PADDING: Record<Density, string> = {
  compact: "py-1.5",
  default: "py-2.5",
  comfortable: "py-4",
};

export default function PatientsPage() {
  const [rows, setRows] = useState<PatientView[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PatientStatus>("active");
  const [density, setDensity] = useState<Density>("default");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced search refetch.
  useEffect(() => {
    const t = setTimeout(() => fetchRows(), search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status]);

  async function fetchRows() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("status", status);
      const res = await fetch(`/api/patients?${params.toString()}`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to load patients.");
        setRows([]);
        setTotal(0);
        return;
      }
      setRows(data.data.rows);
      setTotal(data.data.total ?? data.data.rows.length);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  const empty = useMemo(() => !loading && rows.length === 0, [loading, rows]);

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Patients</h1>
          <p className="text-slate-600 mt-1">
            {total > 0 ? `${total} ${status} patient${total === 1 ? "" : "s"}` : "No patients yet"}
          </p>
        </div>
        <Link href="/patients/new">
          <Button>New patient</Button>
        </Link>
      </header>

      <Card>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
          <TextInput
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 h-9 text-sm"
            aria-label="Search patients"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as PatientStatus)}
            aria-label="Filter status"
            className="h-9 px-3 rounded-md border border-slate-300 bg-white text-sm"
          >
            <option value="active">Active</option>
            <option value="discharged">Discharged</option>
            <option value="deceased">Deceased</option>
            <option value="archived">Archived</option>
          </select>
          <div className="ml-auto flex items-center gap-1 text-xs text-slate-600">
            <span className="mr-1">Density:</span>
            {(["compact", "default", "comfortable"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDensity(d)}
                className={`px-2 py-1 rounded ${density === d ? "bg-slate-200 text-slate-900 font-medium" : "text-slate-500 hover:bg-slate-100"}`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <CardContent className="p-0">
          {error && (
            <div role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">
              {error}
            </div>
          )}
          {loading && (
            <div className="px-4 py-3 text-sm text-slate-500">Loading…</div>
          )}
          {empty && (
            <div className="px-4 py-12 text-center text-slate-500">
              No patients match the filter.{" "}
              <Link
                href="/patients/new"
                className="text-[var(--color-brand-700)] underline"
              >
                Create one
              </Link>
              .
            </div>
          )}

          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Name</th>
                  <th className="text-left font-semibold px-4 py-2.5">DOB</th>
                  <th className="text-left font-semibold px-4 py-2.5">State</th>
                  <th className="text-left font-semibold px-4 py-2.5">Status</th>
                  <th className="text-left font-semibold px-4 py-2.5">Diagnosis</th>
                  <th className="font-semibold px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className={`px-4 ${DENSITY_PADDING[density]}`}>
                      <Link
                        href={`/patients/${p.id}`}
                        className="text-slate-900 font-medium hover:text-[var(--color-brand-700)]"
                      >
                        {p.lastName}, {p.firstName}
                      </Link>
                    </td>
                    <td className={`px-4 ${DENSITY_PADDING[density]} tabular text-slate-700`}>
                      {p.dateOfBirth}
                    </td>
                    <td className={`px-4 ${DENSITY_PADDING[density]} text-slate-700`}>
                      {p.state ?? "—"}
                    </td>
                    <td className={`px-4 ${DENSITY_PADDING[density]} text-slate-700 capitalize`}>
                      {p.status}
                    </td>
                    <td className={`px-4 ${DENSITY_PADDING[density]} font-mono text-xs text-slate-600`}>
                      {p.primaryDiagnosisIcd10 ?? "—"}
                    </td>
                    <td className={`px-4 ${DENSITY_PADDING[density]} text-right`}>
                      <Link
                        href={`/patients/${p.id}`}
                        className="text-xs text-[var(--color-brand-700)] hover:underline"
                      >
                        Open →
                      </Link>
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
