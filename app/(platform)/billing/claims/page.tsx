/**
 * /billing/claims — billing agent triage queue.
 *
 * Source: pallio_complete_vision_v3 §6.4 (claims workflow).
 *
 * Two stacked tables:
 *   - Documented visits awaiting superbill generation
 *   - Draft / ready-to-submit superbills awaiting submission
 *
 * Click-through actions take the agent into the visit superbill page
 * (where the PDF is generated) or the superbill detail.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface VisitRow {
  id: string;
  visitType: string;
  status: string;
  patientId: string;
  scheduledStart: string | null;
  startTime: string | null;
  totalMinutes: number | null;
}

interface SuperbillRow {
  id: string;
  status: string;
  dateOfService: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
}

const READY_VISIT_STATUS = ["documented", "pending_billing"] as const;
const ACTIONABLE_SUPERBILL_STATUS = ["draft", "ready_to_submit"];

export default function ClaimsQueuePage() {
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [superbills, setSuperbills] = useState<SuperbillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const [v, s] = await Promise.all([
          fetch("/api/visits?limit=200").then((r) => r.json()),
          fetch("/api/superbills?limit=200").then((r) => r.json()),
        ]);
        if (abandoned) return;
        if (v.success) {
          setVisits(
            (v.data?.rows ?? []).filter((row: VisitRow) =>
              (READY_VISIT_STATUS as readonly string[]).includes(row.status),
            ),
          );
        }
        if (s.success) {
          setSuperbills(
            (s.data?.rows ?? []).filter((row: SuperbillRow) =>
              ACTIONABLE_SUPERBILL_STATUS.includes(row.status),
            ),
          );
        }
        if (!v.success || !s.success) {
          setError((v.error ?? s.error) ?? null);
        }
      } catch {
        if (!abandoned) setError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => { abandoned = true; };
  }, []);

  const totals = useMemo(
    () => ({
      visits: visits.length,
      drafts: superbills.filter((s) => s.status === "draft").length,
      ready: superbills.filter((s) => s.status === "ready_to_submit").length,
      pendingCents: superbills.reduce((sum, s) => sum + s.billedAmountCents, 0),
    }),
    [visits, superbills],
  );

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Claims queue</h1>
        <p className="text-slate-600 mt-1">
          Visits awaiting superbill + superbills awaiting submission.
        </p>
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        <KPI label="Awaiting superbill" value={totals.visits.toString()} />
        <KPI label="Draft superbills"   value={totals.drafts.toString()} />
        <KPI label="Ready to submit"    value={totals.ready.toString()} />
        <KPI label="Pending charges"    value={`$${(totals.pendingCents / 100).toFixed(0)}`} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Documented visits awaiting superbill</CardTitle>
          <CardDescription>
            {loading ? "Loading…" : `${visits.length} visit${visits.length === 1 ? "" : "s"} ready to bill`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!loading && visits.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">
              All documented visits have superbills. Nothing here.
            </p>
          ) : visits.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Visit type</th>
                  <th className="text-left font-semibold px-4 py-2.5">Status</th>
                  <th className="text-right font-semibold px-4 py-2.5">Minutes</th>
                  <th className="text-right font-semibold px-4 py-2.5">When</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visits.map((v) => (
                  <tr key={v.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">{v.visitType.replace(/_/g, " ")}</td>
                    <td className="px-4 py-2 text-xs">{v.status.replace("_", " ")}</td>
                    <td className="px-4 py-2 text-right tabular">{v.totalMinutes ?? "—"}</td>
                    <td className="px-4 py-2 text-right text-xs text-slate-500 tabular">
                      {(v.startTime ?? v.scheduledStart ?? "").slice(0, 10)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/visits/${v.id}/superbill`}
                        className="text-xs text-[var(--color-brand-700)] hover:underline"
                      >
                        Generate →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Draft + ready superbills</CardTitle>
          <CardDescription>
            {loading ? "Loading…" : `${superbills.length} awaiting submission`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!loading && superbills.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">
              No draft or ready-to-submit superbills.
            </p>
          ) : superbills.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">DOS</th>
                  <th className="text-left font-semibold px-4 py-2.5">Status</th>
                  <th className="text-right font-semibold px-4 py-2.5">Billed</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {superbills.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 tabular text-slate-700">{s.dateOfService.slice(0, 10)}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset bg-amber-50 text-amber-800 ring-amber-600/30">
                        {s.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular">${(s.billedAmountCents / 100).toFixed(2)}</td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/billing/superbills`}
                        className="text-xs text-[var(--color-brand-700)] hover:underline"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
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
        <div className="text-3xl font-bold tabular text-slate-900">{value}</div>
      </CardContent>
    </Card>
  );
}
