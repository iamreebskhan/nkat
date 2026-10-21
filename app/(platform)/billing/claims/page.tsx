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

import { CodeList } from "@/components/billing/code-list";
import { SubmissionDisclosure } from "@/components/billing/submission-disclosure";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface VisitRow {
  id: string;
  visitType: string;
  status: string;
  patientId: string;
  /** On the wire from listVisits; this queue never showed it (audit R16). */
  patientName?: string | null;
  scheduledStart: string | null;
  startTime: string | null;
  /** The visit's day where the practice is (VisitView.serviceDay). */
  serviceDay: string | null;
  totalMinutes: number | null;
  /** The band the visit's type bills as; 'non_billable' is never billed (audit R18). */
  codingBasis?: string;
}

interface SuperbillRow {
  id: string;
  visitId: string;
  patientId: string;
  /** Joined on the server so a row says whose claim it is (audit R16). */
  patientName: string;
  status: string;
  dateOfService: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
  /** Always on the API row; this queue simply never rendered it before. */
  cptCodes: string[];
  /** From the rulebook-fed code table; null for a code not in it. */
  codeDescriptors?: Record<string, string | null>;
}

const READY_VISIT_STATUS = ["documented", "pending_billing"] as const;
const ACTIONABLE_SUPERBILL_STATUS = ["draft", "ready_to_submit"];

export default function ClaimsQueuePage() {
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [superbills, setSuperbills] = useState<SuperbillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Never present a capped list as if it were the whole queue.
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        // One request per status, filtered server-side. Fetching the 200
        // newest rows and filtering here truncated BEFORE it filtered: any
        // work outside the 200 most recent rows vanished from the queue while
        // the KPI cards presented that truncated count as the total.
        //
        // Sequential, NOT Promise.all. Every one of these opens a
        // withOrgContext transaction to set the tenant GUC, and firing four at
        // once exhausted the Prisma pool — the requests came back
        // "Unable to start a transaction in the given time" (P2028) and the
        // page rendered all-zero KPIs as if the queue were empty. A queue
        // screen does not need the parallelism badly enough to risk that.
        const seq = async (urls: string[]) => {
          const out = [];
          for (const u of urls) {
            if (abandoned) return out;
            out.push(await fetch(u).then((r) => r.json()).catch(() => ({ success: false })));
          }
          return out;
        };
        const vRes = await seq(READY_VISIT_STATUS.map((st) => `/api/visits?status=${st}&limit=200`));
        const sRes = await seq(
          ACTIONABLE_SUPERBILL_STATUS.map((st) => `/api/superbills?status=${st}&limit=200`),
        );
        if (abandoned) return;

        const failed = [...vRes, ...sRes].find((r) => !r.success);
        if (failed) setError(failed.error ?? "Could not load the queue.");

        const bills: SuperbillRow[] = sRes
          .filter((r) => r.success)
          .flatMap((r) => r.data?.rows ?? []);
        // Signing now raises the draft automatically, so nearly every
        // pending_billing visit already has a bill. Without this the
        // "awaiting superbill" table would list every signed visit forever.
        const billedVisitIds = new Set(bills.map((b) => b.visitId));
        // A "Not billed" visit type rests at documented for good (audit R18):
        // it is finished, not awaiting a bill, and the server refuses to draft
        // one. Listing it here would leave it in this queue forever.
        setVisits(
          vRes
            .filter((r) => r.success)
            .flatMap((r) => r.data?.rows ?? [])
            .filter(
              (v: VisitRow) => !billedVisitIds.has(v.id) && v.codingBasis !== "non_billable",
            ),
        );
        setSuperbills(bills);

        // More behind a page: both lists now ask the server how many rows the
        // filter matches and compare that with what arrived. Visits used to
        // infer it from a full page (`length >= 200`), so a status holding
        // EXACTLY 200 visits — the whole list, nothing left out — raised the
        // amber "there is more in the queue than the counts below" banner and
        // told the agent to work through them and reload for rows that do not
        // exist. /api/visits returns the COUNT under the same filters the rows
        // are read with, the .own clinician narrowing included, so the two
        // checks are the same honest comparison.
        setTruncated(
          vRes.some(
            (r) => r.success && Number(r.data?.total ?? 0) > (r.data?.rows ?? []).length,
          ) ||
            sRes.some(
              (r) => r.success && Number(r.data?.total ?? 0) > (r.data?.rows ?? []).length,
            ),
        );
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
          Visits awaiting a superbill, and superbills your team has not yet recorded as submitted.
        </p>
        {/* Submission happens outside Pallio (audit R35). */}
        <SubmissionDisclosure />
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {truncated && (
        <div className="text-sm text-amber-900 bg-amber-50 ring-1 ring-inset ring-amber-600/30 px-3 py-2 rounded mb-4">
          Showing the first 200 per status — there is more in the queue than the
          counts below. Work through these and reload.
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
              {/* Not "all documented visits have superbills": a visit on a
                  "Not billed" type is filtered out above and never gets one,
                  so this sentence was false on exactly the org that has one. */}
              Nothing waiting to bill. A documented visit shows here until its
              superbill is drafted; a visit on a Not billed type never does.
            </p>
          ) : visits.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Patient</th>
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
                    <td className="px-4 py-2">
                      <Link
                        href={`/patients/${v.patientId}`}
                        className="text-[var(--color-brand-700)] hover:underline"
                      >
                        {v.patientName || "—"}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{v.visitType.replace(/_/g, " ")}</td>
                    <td className="px-4 py-2 text-xs">{v.status.replace(/_/g, " ")}</td>
                    <td className="px-4 py-2 text-right tabular">{v.totalMinutes ?? "—"}</td>
                    <td className="px-4 py-2 text-right text-xs text-slate-500 tabular">
                      {/* The practice's day, which is the bill's date of service.
                          Slicing the instant gave its UTC day. */}
                      {v.serviceDay ?? ""}
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
                  <th className="text-left font-semibold px-4 py-2.5">Patient</th>
                  <th className="text-left font-semibold px-4 py-2.5">Codes</th>
                  <th className="text-left font-semibold px-4 py-2.5">Status</th>
                  <th className="text-right font-semibold px-4 py-2.5">Billed</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {superbills.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 align-top">
                    <td className="px-4 py-2 tabular text-slate-700">{s.dateOfService.slice(0, 10)}</td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/patients/${s.patientId}`}
                        className="text-[var(--color-brand-700)] hover:underline"
                      >
                        {s.patientName || "—"}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <CodeList codes={s.cptCodes} descriptors={s.codeDescriptors} />
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset bg-amber-50 text-amber-800 ring-amber-600/30">
                        {s.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular">${(s.billedAmountCents / 100).toFixed(2)}</td>
                    <td className="px-4 py-2 text-right">
                      {/* To this claim's own review page. It pointed at the
                          whole superbills list, a dead loop (audit R16). */}
                      <Link
                        href={`/visits/${s.visitId}/superbill`}
                        className="text-xs text-[var(--color-brand-700)] hover:underline"
                      >
                        Review →
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
