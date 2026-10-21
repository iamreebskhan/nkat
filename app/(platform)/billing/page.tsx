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

import { SubmissionDisclosure } from "@/components/billing/submission-disclosure";
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
    /** The part of paidCents posted from a payer's 835 (audit R10). */
    paidFromRemittanceCents: number;
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
  denials: {
    total: number;
    withoutReason: number;
    /** Posted from a payer's 835, with its own CARC (audit R10). */
    fromRemittance: number;
    byPayer: DenialGroup[];
    byReason: DenialGroup[];
    byCode: DenialGroup[];
  };
  adjustments: { edits: number; refiles: number; total: number; claimsAffected: number };
  truncated: { byClient: boolean; byNurse: boolean };
}

interface DenialGroup {
  key: string;
  label: string;
  count: number;
  amountCents: number;
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

  // Async IIFE with an abandon flag rather than a bare `void load()`: React
  // treats the latter as a synchronous setState in the effect body.
  useEffect(() => {
    let abandoned = false;
    (async () => {
      const r = await fetch("/api/billing/overview").catch(() => null);
      if (!r || abandoned) return;
      const d = await r.json().catch(() => null);
      if (!d || abandoned) return;
      if (!d.success) setError(d.error ?? "Failed to load billing.");
      else {
        setData(d.data);
        setError(null);
      }
      setLoading(false);
    })();
    return () => {
      abandoned = true;
    };
  }, []);

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Billing</h1>
          <p className="text-slate-600 mt-1">
            Every claim your team is working — billed, recorded payments, and what needs a fix.
          </p>
          {/* Pallio sends no claim (audit R35), so the figures below are the
              team's own record, except what a payer's 835 posted after the
              team uploaded it on Remittances (R10), which is counted apart. */}
          <SubmissionDisclosure>
            {data && data.totals.paidFromRemittanceCents > 0
              ? `${money(data.totals.paidFromRemittanceCents)} of what was collected was posted from payer 835 files.`
              : null}
          </SubmissionDisclosure>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/billing/lookup"><Button variant="secondary">Rule lookup</Button></Link>
          <Link href="/billing/superbills"><Button variant="secondary">All superbills</Button></Link>
          <Link href="/billing/denials"><Button variant="secondary">Denials</Button></Link>
          <Link href="/billing/remittances"><Button variant="secondary">Remittances</Button></Link>
          <Link href="/billing/claims">
            <Button variant="secondary">Claims queue</Button>
          </Link>
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
            <Kpi
              label="Collected"
              value={money(data.totals.paidCents)}
              sub={
                data.totals.paidFromRemittanceCents > 0
                  ? `${money(data.totals.paidFromRemittanceCents)} confirmed by payer remittance`
                  : "Payments your team recorded"
              }
            />
            <Kpi
              label="Outstanding"
              value={money(data.totals.outstandingCents)}
              sub="Recorded as submitted, not settled"
            />
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
              <CardDescription>Where every claim sits, as recorded by your team.</CardDescription>
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

          {/*
            The client's own words, 20 Aug 2026 [14:00–14:13]: "see the status
            of how much their billing is, how many adjustments they've had to
            make, how many denials they've had, WHERE THOSE DENIALS WERE, where
            they could manage their billing."

            The amounts and the pipeline above answer the first part. These two
            cards answer the middle two, and the by-payer / by-reason split is
            the "where".
          */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <Card>
              <CardHeader>
                <CardTitle>Denials — where they came from</CardTitle>
                <CardDescription>
                  {data.denials.total === 0
                    ? "No denials recorded."
                    : // Every denial not written off, settled or not: a remittance
                      // can mark one paid, so "open" would miscount (audit R10).
                      `${data.denials.total} denial${data.denials.total === 1 ? "" : "s"} on record (written-off excluded)` +
                      (data.denials.withoutReason > 0
                        ? ` · ${data.denials.withoutReason} still without a payer reason code`
                        : "") +
                      (data.denials.fromRemittance > 0
                        ? ` · ${data.denials.fromRemittance} from payer 835 files`
                        : "")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {data.denials.total === 0 ? (
                  <p className="text-sm text-slate-500">
                    {/* It said "logged payer remittances" before anything read
                        one (audit R35). A payer's 835 now posts here once the
                        team uploads it (R10). */}
                    Nothing to show yet. Denials here come from claims your team marked
                    denied, EOB denials logged on the Log denial page, and payer 835 files
                    uploaded on Remittances.
                  </p>
                ) : (
                  <>
                    <DenialGroupList
                      title="By payer"
                      rows={data.denials.byPayer}
                      hrefFor={(k) =>
                        k === "unknown" ? null : `/billing/denials?decision=all&payerId=${k}`
                      }
                    />
                    <DenialGroupList title="By reason" rows={data.denials.byReason} />
                    <DenialGroupList title="By procedure code" rows={data.denials.byCode} />
                    <Link
                      href="/billing/denials?decision=all"
                      className="inline-block text-sm text-[var(--color-brand-700)] underline"
                    >
                      Work the denials queue →
                    </Link>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Adjustments</CardTitle>
                <CardDescription>
                  Rework on claims — corrections made after a bill was raised, and
                  denied claims sent out again. Not contractual adjustments.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-2xl font-bold tabular">{data.adjustments.edits}</p>
                    <p className="text-xs text-slate-500 mt-1">edits</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold tabular">{data.adjustments.refiles}</p>
                    <p className="text-xs text-slate-500 mt-1">refiles</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold tabular">{data.adjustments.claimsAffected}</p>
                    <p className="text-xs text-slate-500 mt-1">claims touched</p>
                  </div>
                </div>
                {data.adjustments.total === 0 && (
                  <p className="text-sm text-slate-500 mt-4">
                    No claim has needed correcting or refiling.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>By client</CardTitle>
                <CardDescription>
                  What&rsquo;s running for each patient.
                  {data.truncated.byClient && " Showing the busiest only — there are more."}
                </CardDescription>
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
                        // One row per patient AND payer (the query groups by
                        // both), so a patient billed to two payers is two rows:
                        // keyed by patient alone they collided.
                        <tr key={`${c.patientId}|${c.payerName ?? ""}`} className="hover:bg-slate-50">
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
                <CardDescription>
                  Who raised what, and how it landed.
                  {data.truncated.byNurse && " Showing the busiest only — there are more."}
                </CardDescription>
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

/**
 * One grouping of denials — by payer, by reason, or by procedure code.
 *
 * Capped at five rows with the remainder counted rather than silently dropped:
 * a client reading "where are my denials" needs to know whether they are
 * looking at all of them.
 */
function DenialGroupList({
  title,
  rows,
  hrefFor,
}: {
  title: string;
  rows: { key: string; label: string; count: number; amountCents: number }[];
  /** Where a row leads: its denials in the queue (audit R29). */
  hrefFor?: (key: string) => string | null;
}) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, 5);
  const rest = rows.length - shown.length;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">{title}</p>
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.key} className="flex items-baseline justify-between gap-3 text-sm">
            {hrefFor?.(r.key) ? (
              <Link
                href={hrefFor(r.key)!}
                className="text-[var(--color-brand-700)] hover:underline truncate"
              >
                {r.label}
              </Link>
            ) : (
              <span className="text-slate-700 truncate">{r.label}</span>
            )}
            <span className="shrink-0 tabular text-slate-600">
              {r.count} · ${(r.amountCents / 100).toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="text-xs text-slate-500 mt-1">and {rest} more</p>
      )}
    </div>
  );
}
