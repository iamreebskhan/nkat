/**
 * /billing/denials — list + filter view.
 *
 * Source: pallio_complete_vision_v3 §6.5 (denial management).
 *
 * Filterable by decision (pending / refile / write_off / appeal) so
 * the billing agent can triage. "Log denial" CTA top-right.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Pager } from "@/components/ui/pager";
import { lookupCarc, type DenialSummary } from "@/lib/features/denials/denial-pure";
import {
  DENIAL_DECISIONS,
  type DenialDecision,
  type DenialView,
} from "@/lib/features/denials/denial.types";

const PAGE_SIZE = 50;

const NO_METRICS: DenialSummary = {
  total: 0,
  totalDeniedCents: 0,
  pendingDecisions: 0,
  byCarc: [],
  byPayerId: [],
  payerNames: {},
};

export default function DenialsPage() {
  const [rows, setRows] = useState<DenialView[]>([]);
  // Over EVERY denial matching the filter, computed on the server. These
  // figures used to be computed here over the rows loaded, which was one page
  // of 50, so past 50 the header, the KPIs and the by-payer table all
  // described an arbitrary page (audit R34).
  const [metrics, setMetrics] = useState<DenialSummary>(NO_METRICS);
  const [decision, setDecision] = useState<DenialDecision | "all">("pending");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // /billing's "where the denials came from" rows link here pre-filtered
  // (audit R29): ?decision=all&payerId=…. The page used to ignore the URL and
  // open on "pending", which for a refiled denial read 0 denials. Read once,
  // from a timer rather than synchronously in the effect body, and hold the
  // first fetch until it has been read.
  const [payerId, setPayerId] = useState<string | null>(null);
  const [urlRead, setUrlRead] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams(window.location.search);
      const d = q.get("decision");
      if (d === "all" || (d && (DENIAL_DECISIONS as readonly string[]).includes(d))) {
        setDecision(d as DenialDecision | "all");
      }
      const p = q.get("payerId");
      if (p && /^[0-9a-f-]{36}$/i.test(p)) setPayerId(p);
      setUrlRead(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!urlRead) return;
    let abandoned = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
        });
        if (decision !== "all") params.set("decision", decision);
        if (payerId) params.set("payerId", payerId);
        const r = await fetch(`/api/denials?${params.toString()}`);
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setError(data.error ?? "Failed to load.");
          setRows([]);
          setMetrics(NO_METRICS);
          return;
        }
        setError(null);
        setRows(data.data.rows ?? []);
        setMetrics(data.data.metrics ?? NO_METRICS);
      } catch {
        if (!abandoned) setError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [decision, page, payerId, urlRead]);

  // payer id → name, so the by-payer table and the filter caption read like a
  // report and not a list of UUIDs. It comes with the figures, withdrawn
  // payers included: /api/billing/payers lists active payers only (R17), so a
  // withdrawn payer used to print as the first 8 characters of its UUID.
  const payerNames = metrics.payerNames;

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Denials</h1>
          {/* Names the filter, so "0 denials" is never read as "no denials". */}
          <p className="text-slate-600 mt-1">
            {metrics.total} {decision === "all" ? "" : `${decision.replace("_", " ")} `}denial
            {metrics.total === 1 ? "" : "s"}
            {payerId ? ` for ${payerNames[payerId] ?? "this payer"}` : ""} ·{" "}
            <span className="tabular">
              ${(metrics.totalDeniedCents / 100).toFixed(2)}
            </span>{" "}
            denied
          </p>
          {payerId && (
            <button
              type="button"
              onClick={() => {
                setPayerId(null);
                setPage(0);
                window.history.replaceState(null, "", "/billing/denials");
              }}
              className="mt-1 text-xs text-[var(--color-brand-700)] underline"
            >
              Show every payer
            </button>
          )}
        </div>
        <Link href="/billing/denials/log">
          <Button>Log denial</Button>
        </Link>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <KPICard label="Pending decisions" value={metrics.pendingDecisions.toString()} />
        <KPICard
          label="Top CARC"
          value={metrics.byCarc[0] ? `${metrics.byCarc[0].carc} · ${metrics.byCarc[0].count}×` : "—"}
        />
        <KPICard
          label="Top payer impact"
          value={
            metrics.byPayerId[0]
              ? `$${(metrics.byPayerId[0].deniedCents / 100).toFixed(2)}`
              : "—"
          }
        />
      </div>

      {/* Client walkthrough [04:53]: "yeh Reports aur yeh Dashboard same hain
          — filhaal is ko remove kar do." Mostly true, but Reports carried two
          panels the Dashboard never had. This is one of them; losing it with
          the nav entry would have been a silent regression, so it moves here
          — where a billing agent chasing denials would actually look for it. */}
      {metrics.byPayerId.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Denials by payer</CardTitle>
            <CardDescription>
              Where the denied money is concentrated, for the current filter.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="text-left font-semibold py-1">Payer</th>
                  <th className="text-right font-semibold py-1">Count</th>
                  <th className="text-right font-semibold py-1">$ denied</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {metrics.byPayerId.slice(0, 8).map((p) => (
                  <tr key={p.payerId ?? "unknown"}>
                    {/* Named by the server from payer itself, withdrawn payers
                        included (R17); the UUID prefix is a last resort. */}
                    <td className="py-2 text-slate-700">
                      {p.payerId
                        ? (payerNames[p.payerId] ?? p.payerId.slice(0, 8))
                        : "Unknown payer"}
                    </td>
                    <td className="py-2 text-right tabular">{p.count}</td>
                    <td className="py-2 text-right tabular font-medium">
                      ${(p.deniedCents / 100).toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
          <span className="text-sm text-slate-600">Decision:</span>
          {(["all", ...DENIAL_DECISIONS] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setDecision(d);
                setPage(0);
              }}
              className={`px-3 py-1 rounded text-xs ${
                decision === d
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {d.replace("_", " ")}
            </button>
          ))}
        </div>
        <CardContent className="p-0">
          {error && (
            <div role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">
              {error}
            </div>
          )}
          {loading && <div className="px-4 py-3 text-sm text-slate-500">Loading…</div>}
          {!loading && rows.length === 0 && (
            <div className="px-4 py-12 text-center text-slate-500">
              No denials match the filter.{" "}
              <Link href="/billing/denials/log" className="text-[var(--color-brand-700)] underline">
                Log one
              </Link>
              .
            </div>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Date</th>
                  <th className="text-left font-semibold px-4 py-2.5">CPT</th>
                  <th className="text-left font-semibold px-4 py-2.5">CARC</th>
                  <th className="text-left font-semibold px-4 py-2.5">Reason</th>
                  <th className="text-right font-semibold px-4 py-2.5">Denied</th>
                  <th className="text-left font-semibold px-4 py-2.5">Decision</th>
                  <th className="font-semibold px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((d) => {
                  const carc = lookupCarc(d.carcCode);
                  return (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 tabular text-slate-700">
                        {d.deniedAt.slice(0, 10)}
                      </td>
                      <td className="px-4 py-2 font-mono tabular text-slate-700">
                        {d.cptCode}
                      </td>
                      <td className="px-4 py-2 font-mono tabular text-slate-700">
                        {d.carcCode}
                        {/* The payer's own code, posted from its 835 (audit R10). */}
                        {d.source === "remittance" && (
                          <span className="ml-1.5 inline-flex items-center rounded bg-blue-50 px-1.5 py-0.5 font-sans text-[11px] font-medium text-blue-800 ring-1 ring-inset ring-blue-600/20">
                            From 835
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-600 max-w-md truncate" title={carc.text}>
                        {d.denialReason ?? carc.text}
                      </td>
                      <td className="px-4 py-2 text-right tabular font-medium">
                        ${(d.deniedAmountCents / 100).toFixed(2)}
                      </td>
                      <td className="px-4 py-2">
                        <DecisionPill decision={d.decision} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          href={`/billing/denials/${d.id}`}
                          className="text-xs text-[var(--color-brand-700)] hover:underline"
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {metrics.total > PAGE_SIZE && (
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={metrics.total}
              shown={rows.length}
              onPage={setPage}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KPICard({ label, value }: { label: string; value: string }) {
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

function DecisionPill({ decision }: { decision: DenialDecision }) {
  const map: Record<DenialDecision, { cls: string; label: string }> = {
    pending: { cls: "bg-amber-50 text-amber-800 ring-amber-600/30", label: "Pending" },
    refile: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20", label: "Refile" },
    write_off: { cls: "bg-slate-100 text-slate-700 ring-slate-600/20", label: "Write-off" },
    appeal: { cls: "bg-blue-50 text-blue-800 ring-blue-600/20", label: "Appeal" },
  };
  const m = map[decision];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
