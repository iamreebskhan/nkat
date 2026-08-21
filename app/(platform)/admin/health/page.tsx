/**
 * /admin/health — platform_admin live health probe, and the state of the rule
 * library underneath it.
 *
 * The liveness probe was the whole page: app up, Postgres answers in under two
 * seconds. That says the process is running, which is the least interesting
 * thing that can be true about this product. Meanwhile
 * /api/admin/library-health — whose own comment calls it "the single place
 * that answers 'is the rule library actually working, and what does it not
 * know?'" — had no caller anywhere in the app. The data existed, the endpoint
 * existed, and no human could see either.
 *
 * That is the failure the endpoint was written for, played out on the endpoint
 * itself: the library ran with three sources and rules for three of nineteen
 * payers for months, because a lookup returning "Unknown" looks the same
 * whether the payer has no such rule or the library is simply empty.
 */
"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Livez {
  ok: boolean;
  db: string;
  uptime_ms?: number;
  reason?: string;
}

interface LibrarySummary {
  payersTotal: number;
  payersWithAnyRule: number;
  payersWithNoRule: number;
  payersWithNoSource: number;
  sourcesActive: number;
  sourcesNeedingAttention: number;
  liveRules: number;
  coreCodeCoveragePct: number;
}

interface SourceHealth {
  id: string;
  name: string;
  status: string;
  detail: string;
  active: boolean;
  payerName: string | null;
  state: string | null;
}

interface WeakCitation {
  payerName: string;
  url: string;
  ruleCount: number;
  codeCount: number;
  quote: string;
  sampleCodes: string[];
}

interface PayerCoverage {
  payerId: string;
  payerName: string;
  states: string[];
  coreCodesCovered: number;
  coreCodesTargeted: number;
  totalRules: number;
  sourceCount: number;
  missingCoreCodes: string[];
}

export default function HealthPage() {
  const [live, setLive] = useState<Livez | null>(null);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [coverage, setCoverage] = useState<PayerCoverage[]>([]);
  const [weak, setWeak] = useState<WeakCitation[]>([]);
  const [libError, setLibError] = useState<string | null>(null);

  async function probe() {
    const res = await fetch("/api/health/livez", { cache: "no-store" });
    setLive(await res.json());
  }

  async function loadLibrary() {
    try {
      const res = await fetch("/api/admin/library-health", { cache: "no-store" });
      const d = await res.json();
      if (!d.success) { setLibError(d.error ?? "Could not read library health."); return; }
      setLibError(null);
      setSummary(d.data.summary);
      setSources(d.data.sources ?? []);
      setCoverage(d.data.coverage ?? []);
      setWeak(d.data.weakCitations ?? []);
    } catch {
      setLibError("Could not reach the library-health endpoint.");
    }
  }

  useEffect(() => {
    void probe();
    // Not on the 5s liveness interval: this one walks the whole rule library.
    void loadLibrary();
    const id = setInterval(probe, 5_000);
    return () => clearInterval(id);
  }, []);

  // Anything not "ok" is what an operator came here to find, so it goes first
  // and the healthy majority stays collapsed into a count.
  //
  // ACTIVE only, matching how the summary above counts sourcesNeedingAttention
  // (`s.active && s.status !== "ok"`). Without the active check this table
  // said "2 of 28 not ok" directly beneath a stat reading 0, because both
  // were sources somebody had deliberately switched off — the renumbered
  // Aetna bulletin and the retired test fixture. A source that is off is a
  // decision, not a problem, and two numbers on one screen describing the
  // same thing differently is the failure this page exists to stop.
  const attention = sources.filter((s) => s.active && s.status !== "ok");
  const offAndNotOk = sources.filter((s) => !s.active && s.status !== "ok").length;
  const thinCoverage = coverage
    .filter((c) => c.coreCodesTargeted > 0 && c.coreCodesCovered < c.coreCodesTargeted)
    .sort((a, b) =>
      a.coreCodesCovered / a.coreCodesTargeted - b.coreCodesCovered / b.coreCodesTargeted);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Platform health</h1>
        <p className="text-slate-600 mt-1">
          Liveness every 5s, and the state of the rule library the product answers from.
        </p>
      </header>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Liveness</CardTitle>
          <CardDescription>App up + Postgres reachable within 2s.</CardDescription>
        </CardHeader>
        <CardContent>
          {live === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <div>
              <div
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium ring-1 ring-inset ${
                  live.ok
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
                    : "bg-red-50 text-red-800 ring-red-600/30"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${live.ok ? "bg-emerald-500" : "bg-red-500"}`}
                  aria-hidden
                />
                {live.ok ? "Healthy" : "Unhealthy"}
              </div>
              <dl className="grid grid-cols-2 gap-4 mt-4 text-sm">
                <div>
                  <dt className="text-xs text-slate-500 uppercase tracking-wide">Database</dt>
                  <dd className="font-mono">{live.db}</dd>
                </div>
                {live.uptime_ms != null && (
                  <div>
                    <dt className="text-xs text-slate-500 uppercase tracking-wide">DB ping (ms)</dt>
                    <dd className="font-mono tabular">{live.uptime_ms}</dd>
                  </div>
                )}
                {live.reason && (
                  <div className="col-span-2">
                    <dt className="text-xs text-slate-500 uppercase tracking-wide">Reason</dt>
                    <dd className="font-mono text-red-700">{live.reason}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </CardContent>
      </Card>

      {libError && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-6">
          {libError}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Rule library</CardTitle>
          <CardDescription>
            What the product can actually answer from. A lookup returning
            &ldquo;Unknown&rdquo; looks the same whether the payer has no such rule or
            the library is empty — these numbers are the difference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {summary === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <Stat label="Live rules" value={summary.liveRules.toLocaleString()} />
              <Stat
                label="Core code coverage"
                value={`${summary.coreCodeCoveragePct}%`}
                bad={summary.coreCodeCoveragePct < 90}
              />
              <Stat
                label="Payers with no rule"
                value={summary.payersWithNoRule}
                sub={`of ${summary.payersTotal}`}
                bad={summary.payersWithNoRule > 0}
              />
              <Stat
                label="Payers with no source"
                value={summary.payersWithNoSource}
                sub={`of ${summary.payersTotal}`}
                bad={summary.payersWithNoSource > 0}
              />
              <Stat label="Active sources" value={summary.sourcesActive} />
              <Stat
                label="Sources needing attention"
                value={summary.sourcesNeedingAttention}
                bad={summary.sourcesNeedingAttention > 0}
              />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Sources needing attention</CardTitle>
          <CardDescription>
            {summary === null
              ? "…"
              : `${attention.length === 0
                  ? `All ${summary.sourcesActive} active sources reporting ok.`
                  : `${attention.length} of ${summary.sourcesActive} active sources not ok. The rest are healthy and not listed.`}` +
                (offAndNotOk
                  ? ` ${offAndNotOk} inactive source${offAndNotOk === 1 ? "" : "s"} also report a problem — switched off deliberately, so not counted here.`
                  : "")}
          </CardDescription>
        </CardHeader>
        {attention.length > 0 && (
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Source</th>
                  <th className="text-left font-semibold px-4 py-2.5">Status</th>
                  <th className="text-left font-semibold px-4 py-2.5">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {attention.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{s.name}</div>
                      <div className="text-xs text-slate-500">
                        {s.payerName ?? "no payer"}
                        {s.state ? ` · ${s.state}` : ""}
                        {s.active ? "" : " · inactive"}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{s.status}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Citations that do not mention their code</CardTitle>
          <CardDescription>
            {weak.length === 0
              ? "Every live rule's quote names the code it supports."
              : `${weak.reduce((n, w) => n + w.ruleCount, 0)} live rules across ` +
                `${weak.length} quote${weak.length === 1 ? "" : "s"}. Drift checks whether a ` +
                `citation is still there; this checks whether it says anything about the rule. ` +
                `A biller clicking through for evidence reads the quote below.`}
          </CardDescription>
        </CardHeader>
        {weak.length > 0 && (
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Payer</th>
                  <th className="text-left font-semibold px-4 py-2.5">Rules / codes</th>
                  <th className="text-left font-semibold px-4 py-2.5">Quote</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {weak.map((w) => (
                  <tr key={`${w.payerName}-${w.quote.slice(0, 40)}`}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{w.payerName}</div>
                      <div className="text-[11px] text-slate-500 truncate max-w-xs" title={w.url}>
                        {w.url}
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular text-xs whitespace-nowrap">
                      {w.ruleCount} / {w.codeCount}
                      <div className="text-[11px] text-slate-500 font-mono">
                        {w.sampleCodes.join(" ")}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600 italic">
                      &ldquo;{w.quote}&rdquo;
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payers missing core codes</CardTitle>
          <CardDescription>
            {coverage.length === 0
              ? "…"
              : thinCoverage.length === 0
                ? `Every payer covers its core codes.`
                : `${thinCoverage.length} of ${coverage.length} payers, thinnest first. These are the lookups that come back Unknown.`}
          </CardDescription>
        </CardHeader>
        {thinCoverage.length > 0 && (
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Payer</th>
                  <th className="text-left font-semibold px-4 py-2.5">Core codes</th>
                  <th className="text-left font-semibold px-4 py-2.5">Rules</th>
                  <th className="text-left font-semibold px-4 py-2.5">Missing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {thinCoverage.map((c) => (
                  <tr key={c.payerId}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{c.payerName}</div>
                      <div className="text-xs text-slate-500">
                        {c.states.join(", ") || "—"} · {c.sourceCount} source
                        {c.sourceCount === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular text-xs">
                      {c.coreCodesCovered} / {c.coreCodesTargeted}
                    </td>
                    <td className="px-4 py-2 tabular text-xs">{c.totalRules}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">
                      {c.missingCoreCodes.slice(0, 8).join(" ")}
                      {c.missingCoreCodes.length > 8 ? ` +${c.missingCoreCodes.length - 8}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label, value, sub, bad,
}: {
  label: string; value: string | number; sub?: string; bad?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500 uppercase tracking-wide">{label}</dt>
      <dd className={`font-mono tabular text-lg ${bad ? "text-red-700" : "text-slate-900"}`}>
        {value}
        {sub && <span className="text-xs text-slate-400 ml-1">{sub}</span>}
      </dd>
    </div>
  );
}
