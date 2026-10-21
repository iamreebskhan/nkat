/**
 * /audit — append-only audit log viewer.
 *
 * Source: pallio_complete_vision_v3 §15.1 (audit log retention).
 * Filterable by action, user, visit, date range. Cursor-paginated.
 *
 * Audit R24. The buyer asked for "the note and the superbill for each visit".
 * The log recorded that pairing (every superbill_create carries its visitId),
 * but this page showed an eight-character target id and never the payload,
 * and could not filter by visit. It now filters by visit (a visit links here
 * as ?visitId=), prints a whitelisted line of detail per row, and states the
 * data-protection safeguards the organization runs under.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { summarizeAuditPayload } from "@/lib/features/audit/audit-pure";
import type { AuditLogRow } from "@/lib/features/audit/audit.service";

interface Filters {
  action: string;
  userEmail: string;
  visitId: string;
  fromDate: string;
  toDate: string;
}

const NO_FILTERS: Filters = { action: "", userEmail: "", visitId: "", fromDate: "", toDate: "" };

interface Safeguard {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  /**
   * The filters the table was actually loaded with. "Load more" pages through
   * THESE, never the half-typed inputs, or a second visit's rows would be
   * appended below the first visit's trail.
   */
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  /** Only the latest request may land: two quick trail clicks can resolve out of order. */
  const latest = useRef(0);
  const [safeguards, setSafeguards] = useState<Safeguard[] | null>(null);
  const [safeguardError, setSafeguardError] = useState<string | null>(null);

  async function load(reset: boolean, requested: Filters = filters) {
    const f = reset ? requested : applied;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (f.action) params.set("action", f.action);
      if (f.userEmail) params.set("userEmail", f.userEmail);
      if (f.visitId.trim()) params.set("visitId", f.visitId.trim());
      if (f.fromDate) params.set("fromDate", f.fromDate);
      if (f.toDate) params.set("toDate", f.toDate);
      if (!reset && nextCursor) params.set("cursor", nextCursor);
      const r = await fetch(`/api/audit?${params.toString()}`);
      const d = await r.json();
      if (id !== latest.current) return; // a newer request owns the table
      if (!d.success) {
        setError(d.error ?? "Failed.");
        return;
      }
      setRows(reset ? d.data.rows : [...rows, ...d.data.rows]);
      setNextCursor(d.data.nextCursor);
      if (reset) setApplied(f);
    } catch {
      // Without this, a thrown fetch left `loading` stuck true and the
      // Apply / Load-more buttons permanently disabled.
      if (id === latest.current) setError("Network error — try again.");
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }

  /** Narrow the log to one visit's trail, from a row that names it. */
  function showVisit(visitId: string) {
    const f = { ...applied, visitId };
    setFilters(f);
    void load(true, f);
  }

  useEffect(() => {
    // A visit links here as /audit?visitId=…. Read it after mount, from a
    // timer so no state is set synchronously in the effect body, and load
    // with it rather than loading everything first.
    const t = setTimeout(() => {
      const visitId = new URLSearchParams(window.location.search).get("visitId") ?? "";
      const seeded = { ...NO_FILTERS, visitId };
      if (visitId) setFilters(seeded);
      void load(true, seeded);
      void (async () => {
        try {
          const r = await fetch("/api/audit/safeguards", { cache: "no-store" });
          const d = await r.json();
          if (d.success) setSafeguards(d.data.checks as Safeguard[]);
          else setSafeguardError(d.error ?? "The checks could not run.");
        } catch {
          setSafeguardError("Network error — the checks did not run.");
        }
      })();
    }, 0);
    return () => clearTimeout(t);
    // intentionally fires only on mount; user submits filters via the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passing = safeguards?.filter((c) => c.ok).length ?? 0;

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Audit log</h1>
        <p className="text-slate-600 mt-1">
          Append-only. Rows under 6 years old cannot be deleted.
        </p>
      </header>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Safeguards</CardTitle>
          <CardDescription>
            How your organization&rsquo;s records are protected, checked live against the running
            system.
            {safeguards && ` ${passing} of ${safeguards.length} passing.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {safeguardError ? (
            <p role="alert" className="px-4 pb-4 text-sm text-red-700">
              {safeguardError}
            </p>
          ) : !safeguards ? (
            <p className="px-4 pb-4 text-sm text-slate-500">Checking…</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {safeguards.map((c) => (
                <li key={c.id} className="px-4 py-3 flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{c.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{c.detail}</p>
                  </div>
                  <StatusPill ok={c.ok} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
            <FilterField label="Action prefix" value={filters.action}
              onChange={(v) => setFilters({ ...filters, action: v })} placeholder="login, finalize_…" />
            <FilterField label="User email" value={filters.userEmail}
              onChange={(v) => setFilters({ ...filters, userEmail: v })} placeholder="user@org" />
            <FilterField label="Visit ID" value={filters.visitId}
              onChange={(v) => setFilters({ ...filters, visitId: v })} placeholder="one visit's trail" />
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
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 && !loading ? (
            <div className="px-4 py-12 text-center text-slate-500">No audit rows.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">When</th>
                  <th className="text-left font-semibold px-4 py-2.5">User</th>
                  <th className="text-left font-semibold px-4 py-2.5">Action</th>
                  <th className="text-left font-semibold px-4 py-2.5">Details</th>
                  <th className="text-left font-semibold px-4 py-2.5">Target</th>
                  <th className="text-left font-semibold px-4 py-2.5">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const s = summarizeAuditPayload(r.action, r.targetType, r.targetId, r.payload);
                  return (
                    <tr key={r.id} className="hover:bg-slate-50 align-top">
                      <td className="px-4 py-2 tabular text-slate-700 text-xs whitespace-nowrap">
                        {r.occurredAt.replace("T", " ").slice(0, 19)}Z
                      </td>
                      <td className="px-4 py-2 text-slate-700 text-xs">{r.userEmail ?? "—"}</td>
                      <td className="px-4 py-2 font-mono text-xs">{r.action}</td>
                      <td className="px-4 py-2 text-slate-700 text-xs">
                        {s.text || <span className="text-slate-400">—</span>}
                        {s.visitId && (
                          <span className="block mt-0.5 space-x-2">
                            <Link
                              href={`/visits/${s.visitId}/document`}
                              className="font-medium text-[var(--color-brand-700)] hover:underline"
                            >
                              Open visit
                            </Link>
                            {applied.visitId.trim().toLowerCase() !== s.visitId.toLowerCase() && (
                              <button
                                type="button"
                                onClick={() => showVisit(s.visitId!)}
                                disabled={loading}
                                className="font-medium text-[var(--color-brand-700)] hover:underline disabled:opacity-50"
                              >
                                This visit&rsquo;s trail
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-600 text-xs">
                        {r.targetType ?? "—"}
                        {r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ""}
                      </td>
                      <td className="px-4 py-2 text-slate-500 text-xs tabular">{r.ipAddress ?? "—"}</td>
                    </tr>
                  );
                })}
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

/** Pass / Action, the same pill the platform compliance board uses. */
function StatusPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${
        ok
          ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
          : "bg-amber-50 text-amber-800 ring-amber-600/30"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
      {ok ? "Pass" : "Action"}
    </span>
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
