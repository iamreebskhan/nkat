/**
 * Record access — who opened or exported a patient's record, on /audit.
 *
 * phi_access_log and phi_export_log were written and retained for six years,
 * and the audit page's safeguards said so, but no screen showed them: "who
 * looked at this patient's record?" had no answer in the app. This reads them
 * back through /api/audit/record-access (audit.view).
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RecordAccessRow } from "@/lib/features/audit/record-access.service";
import { fetchAllPatients } from "@/lib/features/patients/patient-picker";

interface Filters {
  patientId: string;
  userEmail: string;
  fromDate: string;
  toDate: string;
}

const NONE: Filters = { patientId: "", userEmail: "", fromDate: "", toDate: "" };

const ACCESS_WORDS: Record<string, string> = {
  view: "Opened",
  edit: "Edited",
  export: "Exported",
  print: "Printed",
  api_read: "Read through the API",
};

const words = (s: string) => s.replace(/_/g, " ");

/** "Opened · patient record", "Exported · visit audit packet". */
function describe(r: RecordAccessRow): string {
  if (r.kind === "export") return `Exported · ${words(r.what)}`;
  const verb = ACCESS_WORDS[r.what] ?? words(r.what);
  return r.context ? `${verb} · ${words(r.context)}` : verb;
}

export function RecordAccessCard() {
  const [patients, setPatients] = useState<{ id: string; name: string }[]>([]);
  const [filters, setFilters] = useState<Filters>(NONE);
  const [applied, setApplied] = useState<Filters>(NONE);
  const [rows, setRows] = useState<RecordAccessRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Only the latest request may land. */
  const latest = useRef(0);

  async function load(reset: boolean, requested: Filters = filters) {
    const f = reset ? requested : applied;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (f.patientId) params.set("patientId", f.patientId);
      if (f.userEmail.trim()) params.set("userEmail", f.userEmail.trim());
      if (f.fromDate) params.set("fromDate", f.fromDate);
      if (f.toDate) params.set("toDate", f.toDate);
      if (!reset && nextCursor) params.set("cursor", nextCursor);
      const r = await fetch(`/api/audit/record-access?${params.toString()}`);
      const d = await r.json();
      if (id !== latest.current) return;
      if (!d.success) {
        setError(d.error ?? "Could not load record access.");
        return;
      }
      setRows(reset ? d.data.rows : [...rows, ...d.data.rows]);
      setNextCursor(d.data.nextCursor);
      if (reset) setApplied(f);
    } catch {
      if (id === latest.current) setError("Network error — try again.");
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }

  useEffect(() => {
    // From a timer, so no state is set synchronously in the effect body.
    const t = setTimeout(() => {
      void load(true, NONE);
      // Every patient, page by page: the first page alone left the rest out of
      // the filter.
      fetchAllPatients()
        .then((rows) =>
          setPatients(
            rows.map((p) => ({
              id: p.id,
              name: `${p.lastName ?? ""}, ${p.firstName ?? ""}`.replace(/^, |, $/g, "") || p.id,
            })),
          ),
        )
        .catch(() => {
          /* the filter is still usable without names: it is optional */
        });
    }, 0);
    return () => clearTimeout(t);
    // fires on mount; filters apply through the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Record access</CardTitle>
        <CardDescription>
          Who opened or exported a patient&rsquo;s record, newest first. Kept six years and cannot be
          deleted; times are UTC.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end px-4 pb-4">
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">Patient</span>
            <select
              value={filters.patientId}
              onChange={(e) => setFilters({ ...filters, patientId: e.target.value })}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
            >
              <option value="">Every patient</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">User email</span>
            <input
              value={filters.userEmail}
              onChange={(e) => setFilters({ ...filters, userEmail: e.target.value })}
              placeholder="user@org"
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">From</span>
            <input
              type="date"
              value={filters.fromDate}
              onChange={(e) => setFilters({ ...filters, fromDate: e.target.value })}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">To</span>
            <input
              type="date"
              value={filters.toDate}
              onChange={(e) => setFilters({ ...filters, toDate: e.target.value })}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
            />
          </label>
          <Button onClick={() => load(true)} disabled={loading} size="sm">
            {loading ? "Loading…" : "Apply"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mx-4 mb-4 text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
            {error}
          </p>
        )}
        {rows.length === 0 && !loading ? (
          <div className="px-4 py-10 text-center text-slate-500 text-sm">No record access matches.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">When</th>
                  <th className="text-left font-semibold px-4 py-2.5">User</th>
                  <th className="text-left font-semibold px-4 py-2.5">Patient</th>
                  <th className="text-left font-semibold px-4 py-2.5">What</th>
                  <th className="text-left font-semibold px-4 py-2.5">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}-${r.patientId ?? ""}`} className="align-top">
                    <td className="px-4 py-2 tabular text-slate-700 text-xs whitespace-nowrap">
                      {r.occurredAt.replace("T", " ").slice(0, 19)}Z
                    </td>
                    <td className="px-4 py-2 text-slate-700 text-xs">{r.userEmail ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-700 text-xs">
                      {r.patientName ?? (r.patientId ? r.patientId.slice(0, 8) : "—")}
                    </td>
                    <td className="px-4 py-2 text-slate-700 text-xs">{describe(r)}</td>
                    <td className="px-4 py-2 text-slate-500 text-xs tabular">{r.ipAddress ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <div className="py-3 flex justify-center">
            <Button variant="secondary" size="sm" onClick={() => load(false)} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
