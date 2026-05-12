/**
 * /documents — analyst source document corpus.
 *
 * Lists every source_document the platform has ingested with its
 * extraction status. Click a row to open the original URL.
 */
"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface SourceDoc {
  id: string;
  documentType: string;
  title: string | null;
  url: string;
  payerName: string | null;
  effectiveDate: string | null;
  retrievedAt: string;
  extractedAt: string | null;
  extractionCandidateCount: number;
  extractionError: string | null;
}

interface Stats {
  total: number;
  pendingExtraction: number;
  withErrors: number;
}

export default function DocumentsPage() {
  const [rows, setRows] = useState<SourceDoc[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/documents")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed.");
          return;
        }
        setRows(d.data?.rows ?? []);
        setStats(d.data?.stats ?? null);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Documents</h1>
        <p className="text-slate-600 mt-1">
          Payer policy PDFs, CMS LCDs/NCDs, fee schedules, and final rules ingested into the platform.
        </p>
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          <KPI label="Total documents"      value={stats.total.toLocaleString()} />
          <KPI label="Awaiting extraction"  value={stats.pendingExtraction.toLocaleString()} />
          <KPI label="With extraction errors" value={stats.withErrors.toLocaleString()} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent</CardTitle>
          <CardDescription>{rows.length} most recently retrieved.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading && <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>}
          {!loading && rows.length === 0 && !error && (
            <p className="px-4 py-12 text-center text-sm text-slate-500">No documents ingested.</p>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Title</th>
                  <th className="text-left font-semibold px-4 py-2.5">Type</th>
                  <th className="text-left font-semibold px-4 py-2.5">Payer</th>
                  <th className="text-left font-semibold px-4 py-2.5">Effective</th>
                  <th className="text-left font-semibold px-4 py-2.5">Extraction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 max-w-md truncate">
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[var(--color-brand-700)] hover:underline"
                      >
                        {d.title ?? d.url}
                      </a>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-700">{d.documentType.replace(/_/g, " ")}</td>
                    <td className="px-4 py-2 text-xs text-slate-700">{d.payerName ?? "—"}</td>
                    <td className="px-4 py-2 text-xs text-slate-500 tabular">{d.effectiveDate ?? "—"}</td>
                    <td className="px-4 py-2">
                      {d.extractionError ? (
                        <span title={d.extractionError} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset bg-red-50 text-red-800 ring-red-600/30">
                          error
                        </span>
                      ) : d.extractedAt ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset bg-emerald-50 text-emerald-800 ring-emerald-600/20">
                          {d.extractionCandidateCount} candidates
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset bg-amber-50 text-amber-800 ring-amber-600/30">
                          pending
                        </span>
                      )}
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
