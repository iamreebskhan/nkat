/**
 * /billing — the billing dashboard.
 *
 * Client walkthrough [03:23]: "Yahan pe poora dashboard banega billing ka,
 * jahan pe humare paas saare record ho — ke kis client ke kya cheezein chal
 * rahi hain, kis nurse ne kitne bills, submit wagera."
 *
 * Billing used to land on Rule lookup, which is a research tool, not a work
 * surface. This is the work surface: what's outstanding, what needs attention,
 * who owes what — with Create Bill as the primary action and the research
 * tools one click away.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateBillDialog } from "./create-bill";

interface Overview {
  totals: {
    draft: number;
    readyToSubmit: number;
    submitted: number;
    paid: number;
    partiallyPaid: number;
    denied: number;
    voided: number;
    billedCents: number;
    paidCents: number;
    outstandingCents: number;
    needsAttention: number;
  };
  byClient: {
    patientId: string;
    patientName: string;
    payerName: string | null;
    bills: number;
    billedCents: number;
    paidCents: number;
    deniedCount: number;
    lastActivityAt: string | null;
  }[];
  byNurse: {
    clinicianUserId: string;
    clinicianName: string | null;
    bills: number;
    submitted: number;
    paid: number;
    denied: number;
    billedCents: number;
  }[];
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function BillingDashboardPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return fetch("/api/billing/overview")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed to load billing.");
          return;
        }
        setData(d.data);
        setError(null);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Billing</h1>
          <p className="text-slate-600 mt-1">
            Every claim in flight — what&rsquo;s billed, what&rsquo;s paid, and what needs a fix.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/billing/lookup"><Button variant="secondary">Rule lookup</Button></Link>
          <Link href="/billing/superbills"><Button variant="secondary">All superbills</Button></Link>
          <Link href="/billing/denials"><Button variant="secondary">Denials</Button></Link>
          <Button onClick={() => setCreating(true)}>Create bill</Button>
        </div>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {loading && !data && <p className="text-sm text-slate-500">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Kpi label="Billed" value={money(data.totals.billedCents)} sub="All claims" />
            <Kpi label="Collected" value={money(data.totals.paidCents)} sub="Payments received" />
            <Kpi label="Outstanding" value={money(data.totals.outstandingCents)} sub="Submitted, not settled" />
            <Kpi
              label="Needs attention"
              value={String(data.totals.needsAttention)}
              sub="Denied — fix and resubmit"
              tone={data.totals.needsAttention > 0 ? "warn" : undefined}
            />
          </div>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Pipeline</CardTitle>
              <CardDescription>Where every claim currently sits.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {([
                ["draft", data.totals.draft],
                ["ready to submit", data.totals.readyToSubmit],
                ["submitted", data.totals.submitted],
                ["partially paid", data.totals.partiallyPaid],
                ["paid", data.totals.paid],
                ["denied", data.totals.denied],
                ["voided", data.totals.voided],
              ] as const).map(([label, count]) => (
                <Link
                  key={label}
                  href={`/billing/superbills?status=${label.replace(/ /g, "_")}`}
                  className="rounded-md border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <span className="text-slate-600">{label}</span>{" "}
                  <span className="tabular font-semibold">{count}</span>
                </Link>
              ))}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>By client</CardTitle>
                <CardDescription>What&rsquo;s running for each patient.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {data.byClient.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-slate-500">No bills yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                      <tr>
                        <th className="text-left font-semibold px-4 py-2.5">Client</th>
                        <th className="text-left font-semibold px-4 py-2.5">Payer</th>
                        <th className="text-right font-semibold px-4 py-2.5">Bills</th>
                        <th className="text-right font-semibold px-4 py-2.5">Billed</th>
                        <th className="text-right font-semibold px-4 py-2.5">Paid</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.byClient.map((c) => (
                        <tr key={c.patientId} className="hover:bg-slate-50">
                          <td className="px-4 py-2">
                            <Link href={`/patients/${c.patientId}`} className="hover:underline">
                              {c.patientName}
                            </Link>
                            {c.deniedCount > 0 && (
                              <span className="ml-2 rounded bg-red-50 text-red-800 ring-1 ring-inset ring-red-600/30 px-1.5 py-0.5 text-xs">
                                {c.deniedCount} denied
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-slate-600">{c.payerName ?? "—"}</td>
                          <td className="px-4 py-2 text-right tabular">{c.bills}</td>
                          <td className="px-4 py-2 text-right tabular">{money(c.billedCents)}</td>
                          <td className="px-4 py-2 text-right tabular">{money(c.paidCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>By clinician</CardTitle>
                <CardDescription>Who raised what, and how it landed.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {data.byNurse.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-slate-500">No bills yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                      <tr>
                        <th className="text-left font-semibold px-4 py-2.5">Clinician</th>
                        <th className="text-right font-semibold px-4 py-2.5">Bills</th>
                        <th className="text-right font-semibold px-4 py-2.5">Submitted</th>
                        <th className="text-right font-semibold px-4 py-2.5">Paid</th>
                        <th className="text-right font-semibold px-4 py-2.5">Denied</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.byNurse.map((n) => (
                        <tr key={n.clinicianUserId} className="hover:bg-slate-50">
                          <td className="px-4 py-2">
                            {n.clinicianName ?? n.clinicianUserId.slice(0, 8)}
                          </td>
                          <td className="px-4 py-2 text-right tabular">{n.bills}</td>
                          <td className="px-4 py-2 text-right tabular">{n.submitted}</td>
                          <td className="px-4 py-2 text-right tabular">{n.paid}</td>
                          <td className="px-4 py-2 text-right tabular">{n.denied}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {creating && (
        <CreateBillDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "warn";
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm text-slate-600">{label}</p>
        <p className="text-xs text-slate-500">{sub}</p>
        <p
          className={`mt-2 text-2xl font-semibold tabular ${
            tone === "warn" ? "text-red-700" : "text-slate-900"
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
