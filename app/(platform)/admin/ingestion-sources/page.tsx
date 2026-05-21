/**
 * /admin/ingestion-sources — operator dashboard for Sources 1 & 2 of
 * the rule corpus. List configured URLs, add new ones, see when each
 * was last fetched, what the last hash was, any error, and trigger
 * an on-demand re-ingest per row.
 *
 * Platform-admin only — the underlying API endpoints check
 * session.role === 'platform_admin'.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Source {
  id: string;
  name: string;
  url: string;
  payerId: string | null;
  state: string | null;
  documentType: string;
  scheduleCadence: string;
  lastContentHash: string | null;
  lastCheckAt: string | null;
  lastIngestedAt: string | null;
  lastError: string | null;
  active: boolean;
  notes: string | null;
}

const DOC_TYPES = [
  "medical_policy",
  "reimbursement_policy",
  "provider_manual",
  "mln_article",
  "ncd",
  "lcd",
  "lcd_article",
  "cms_pfs",
  "cms_coverage_api",
  "hcpcs_release",
  "ncci_release",
  "state_medicaid_manual",
  "wc_fee_schedule",
  "ihs_rate",
] as const;

export default function IngestionSourcesPage() {
  const [rows, setRows] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);

  // Add-form state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [docType, setDocType] = useState<(typeof DOC_TYPES)[number]>("reimbursement_policy");
  const [stateCode, setStateCode] = useState("");
  const [payerId, setPayerId] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [notes, setNotes] = useState("");

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/admin/ingestion-sources", { cache: "no-store" });
      const d = await r.json();
      if (!d.success) { setErr(d.error ?? "Failed to load."); return; }
      setRows(d.data.rows);
    } catch {
      setErr("Network error.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/admin/ingestion-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, url, documentType: docType,
          state: stateCode ? stateCode.toUpperCase() : null,
          payerId: payerId || null,
          scheduleCadence: cadence,
          notes: notes || undefined,
        }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error ?? "Failed.");
      setMsg(`Added "${d.data.name}".`);
      setName(""); setUrl(""); setStateCode(""); setPayerId(""); setNotes("");
      setShowAdd(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setAdding(false);
    }
  }

  async function runNow(id: string) {
    setRunBusy((b) => ({ ...b, [id]: true })); setErr(null); setMsg(null);
    try {
      const r = await fetch(`/api/admin/ingestion-sources/${id}/run`, { method: "POST" });
      const d = await r.json();
      if (!d.success) throw new Error(d.error ?? "Run failed.");
      const summary = d.data;
      setMsg(
        summary.alreadyIngested
          ? `No change (same content hash).`
          : `Ingested ${summary.ruleCount} rule${summary.ruleCount === 1 ? "" : "s"} · ${summary.chunkCount} chunk${summary.chunkCount === 1 ? "" : "s"} (embedded=${summary.embedded}).`,
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Run failed.");
      await load();
    } finally {
      setRunBusy((b) => ({ ...b, [id]: false }));
    }
  }

  return (
    <div className="px-8 py-8 max-w-6xl">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Ingestion sources</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-3xl">
            URLs the corpus engine re-checks on a cadence — Sources 1 (CMS)
            and 2 (commercial payer policies) of the rulebook. New rules
            extracted from these documents land in <code>payer_rule</code>
            and surface in every org&rsquo;s lookups + rulebook.
          </p>
        </div>
        <Button onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add source"}
        </Button>
      </header>

      {msg && (
        <p className="mb-4 px-3 py-2 rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-600/20 text-sm text-emerald-800">
          {msg}
        </p>
      )}
      {err && (
        <p role="alert" className="mb-4 px-3 py-2 rounded-md bg-red-50 ring-1 ring-inset ring-red-600/20 text-sm text-red-800">
          {err}
        </p>
      )}

      {showAdd && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Add ingestion source</CardTitle>
            <CardDescription>
              Point at a publicly accessible URL (HTML or PDF). The
              cron + extractor handle the rest.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={add} className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Name" required>
                <input value={name} onChange={(e) => setName(e.target.value)} required className="ip" />
              </Field>
              <Field label="URL" required>
                <input value={url} onChange={(e) => setUrl(e.target.value)} required type="url" className="ip" />
              </Field>
              <Field label="Document type" required>
                <select value={docType} onChange={(e) => setDocType(e.target.value as (typeof DOC_TYPES)[number])} className="ip">
                  {DOC_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </Field>
              <Field label="Cadence">
                <select value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} className="ip">
                  <option value="daily">daily</option>
                  <option value="weekly">weekly</option>
                  <option value="monthly">monthly</option>
                </select>
              </Field>
              <Field label="State (2-letter)">
                <input value={stateCode} onChange={(e) => setStateCode(e.target.value)} maxLength={2} placeholder="OH" className="ip" />
              </Field>
              <Field label="Payer UUID (optional)">
                <input value={payerId} onChange={(e) => setPayerId(e.target.value)} placeholder="a0000000-… (omit for CMS-wide)" className="ip font-mono text-xs" />
              </Field>
              <div className="md:col-span-2">
                <Field label="Notes">
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="ip" />
                </Field>
              </div>
              <div className="md:col-span-2 flex justify-end">
                <Button type="submit" loading={adding}>Add source</Button>
              </div>
            </form>
            <style>{`.ip { width: 100%; border: 1px solid rgb(203 213 225); border-radius: 4px; padding: 6px 8px; font-size: 13px; }`}</style>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Registered sources ({rows.length})</CardTitle>
          <CardDescription>
            Scheduled cron fires daily at 03:15 UTC. Use &ldquo;Run now&rdquo; to re-ingest immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="px-4 py-6 text-sm text-slate-500">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">
              No sources yet — click &ldquo;+ Add source&rdquo; to register one.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2">Name</th>
                  <th className="text-left font-semibold px-4 py-2">Type</th>
                  <th className="text-left font-semibold px-4 py-2">Cadence</th>
                  <th className="text-left font-semibold px-4 py-2">Last check</th>
                  <th className="text-left font-semibold px-4 py-2">Last ingest</th>
                  <th className="text-left font-semibold px-4 py-2">Status</th>
                  <th className="text-right font-semibold px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{r.name}</div>
                      <div className="text-[11px] text-slate-500 truncate max-w-md" title={r.url}>{r.url}</div>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-700">
                      {r.documentType}
                      {r.state && <span className="ml-1 text-slate-500">· {r.state}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">{r.scheduleCadence}</td>
                    <td className="px-4 py-2 text-xs tabular text-slate-600">
                      {r.lastCheckAt ? new Date(r.lastCheckAt).toISOString().slice(0, 19).replace("T", " ") : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs tabular text-slate-600">
                      {r.lastIngestedAt ? new Date(r.lastIngestedAt).toISOString().slice(0, 19).replace("T", " ") : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {r.lastError ? (
                        <span title={r.lastError} className="text-red-700">⚠ error</span>
                      ) : r.lastIngestedAt ? (
                        <span className="text-emerald-700">✓ ok</span>
                      ) : (
                        <span className="text-slate-500">never run</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button onClick={() => runNow(r.id)} loading={runBusy[r.id]} variant="secondary">
                        Run now
                      </Button>
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

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-slate-700 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
