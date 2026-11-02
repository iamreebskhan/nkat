/**
 * /referrals — the referral board (Level-1 doc:24-25, 0111).
 *
 * Every referral from receipt to disposition, by the pipeline's stages, with
 * what is still in its way: triage, a coverage check, pending requirements.
 * The last-12-months line is the pipeline's conversion: of the referrals
 * received, how many were admitted.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { TextInput } from "@/components/forms/field";
import { ACUITY_LABEL, ACUITY_STYLE } from "@/components/referrals/referral-cards";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  REFERRAL_STAGE_LABEL,
  VERIFICATION_RESULT_LABEL,
  type ReferralRow,
  type ReferralStage,
  type ReferralSummary,
} from "@/lib/features/referrals/referral.types";

type Filter = "open" | "all" | ReferralStage;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "pre_admission", label: "Pre-admission" },
  { key: "pending_long_term", label: "Pending long term" },
  { key: "admitted", label: "Admitted" },
  { key: "ntuc", label: "NTUC" },
  { key: "transitioned", label: "Transitioned" },
  { key: "all", label: "All" },
];

const STAGE_STYLE: Record<ReferralStage, string> = {
  pre_admission: "bg-sky-50 text-sky-900 ring-sky-600/30",
  pending_long_term: "bg-amber-50 text-amber-900 ring-amber-600/30",
  admitted: "bg-emerald-50 text-emerald-900 ring-emerald-600/30",
  ntuc: "bg-slate-100 text-slate-700 ring-slate-400/40",
  transitioned: "bg-violet-50 text-violet-900 ring-violet-600/30",
};

function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>
      {children}
    </span>
  );
}

export default function ReferralsPage() {
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ReferralRow[]>([]);
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Receiving a referral is intake's grant; the triaging nurse reads the board.
  const [canReceive, setCanReceive] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setCanReceive((d.data?.permissions ?? []).includes("patients.create"));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let abandoned = false;
    const t = setTimeout(
      () => {
        const qs = new URLSearchParams({ filter, summary: "1" });
        if (search.trim()) qs.set("q", search.trim());
        fetch(`/api/referrals?${qs.toString()}`)
          .then((r) => r.json())
          .then((d) => {
            if (abandoned) return;
            if (!d.success) {
              setError(d.error ?? "Could not load referrals.");
              return;
            }
            setError(null);
            setRows(d.data.rows ?? []);
            setSummary(d.data.summary ?? null);
          })
          .catch(() => {
            if (!abandoned) setError("Network error.");
          })
          .finally(() => {
            if (!abandoned) setLoading(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      abandoned = true;
      clearTimeout(t);
    };
  }, [filter, search]);

  const count = (f: Filter): number | null => {
    if (!summary) return null;
    if (f === "open") return summary.counts.pre_admission + summary.counts.pending_long_term;
    if (f === "all") return null;
    return summary.counts[f];
  };

  return (
    <div className="px-8 py-8">
      <header className="flex flex-wrap items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Referrals</h1>
          <p className="text-slate-600 mt-1">
            {summary && summary.received12m > 0
              ? `Last 12 months: ${summary.received12m} received, ${summary.admitted12m} admitted (${Math.round(
                  (summary.conversion ?? 0) * 100,
                )}% conversion).`
              : "From the day a referral comes in to admission, or the reason it was not taken under care."}
          </p>
        </div>
        {canReceive && (
          <Link href="/referrals/new">
            <Button>New referral</Button>
          </Link>
        )}
      </header>

      <Card>
        <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Referral stage">
            {FILTERS.map((f) => {
              const n = count(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={filter === f.key}
                  onClick={() => {
                    setLoading(true);
                    setFilter(f.key);
                  }}
                  className={`px-2.5 py-1 rounded-md text-sm ${
                    filter === f.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {f.label}
                  {n !== null && <span className="ml-1.5 tabular text-xs opacity-75">{n}</span>}
                </button>
              );
            })}
          </div>
          <TextInput
            placeholder="Search by name or source…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto w-full sm:w-64 h-9 text-sm"
            aria-label="Search referrals"
          />
        </div>
        {["admitted", "ntuc", "transitioned"].includes(filter) && (
          <p className="px-4 pt-2 text-xs text-slate-500">The count beside a closed stage is the last 12 months.</p>
        )}

        <CardContent className="p-0 overflow-x-auto">
          {error && (
            <div role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">
              {error}
            </div>
          )}
          {loading && <div className="px-4 py-3 text-sm text-slate-500">Loading…</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="px-4 py-12 text-center text-slate-500">
              No referrals here.
              {canReceive && filter === "open" && (
                <>
                  {" "}
                  <Link href="/referrals/new" className="text-[var(--color-brand-700)] underline">
                    Record one
                  </Link>
                  .
                </>
              )}
            </div>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Received</th>
                  <th className="text-left font-semibold px-4 py-2.5">Name</th>
                  <th className="text-left font-semibold px-4 py-2.5">Source</th>
                  <th className="text-left font-semibold px-4 py-2.5">Stage</th>
                  <th className="text-left font-semibold px-4 py-2.5">Triage</th>
                  <th className="text-left font-semibold px-4 py-2.5">Coverage</th>
                  <th className="text-left font-semibold px-4 py-2.5">Requirements</th>
                  <th className="text-left font-semibold px-4 py-2.5">Assigned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const open = r.stage === "pre_admission" || r.stage === "pending_long_term";
                  // What is still missing is a warning while the referral is
                  // worked, and only a record once it is closed.
                  const todo = open ? "text-amber-800" : "text-slate-500";
                  return (
                    <tr key={r.id} className="hover:bg-slate-50 align-top">
                      <td className="px-4 py-2.5 tabular text-slate-700">
                        {r.receivedOn}
                        <span className="block text-xs text-slate-500">
                          {r.daysOpen} day{r.daysOpen === 1 ? "" : "s"}
                          {open ? " open" : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/referrals/${r.id}`}
                          className="font-medium text-slate-900 hover:text-[var(--color-brand-700)]"
                        >
                          {r.lastName}, {r.firstName}
                        </Link>
                        {r.dateOfBirth && (
                          <span className="block text-xs text-slate-500 tabular">DOB {r.dateOfBirth}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">
                        {r.sourceName ?? "—"}
                        {r.referringProviderName && (
                          <span className="block text-xs text-slate-500">{r.referringProviderName}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Chip cls={STAGE_STYLE[r.stage]}>{REFERRAL_STAGE_LABEL[r.stage]}</Chip>
                        {r.ntucReason && <span className="block mt-0.5 text-xs text-slate-500">{r.ntucReason}</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.latestAcuity ? (
                          <Chip cls={ACUITY_STYLE[r.latestAcuity]}>{ACUITY_LABEL[r.latestAcuity]}</Chip>
                        ) : r.triaged ? (
                          <span className="text-xs text-slate-600">Triaged</span>
                        ) : (
                          <span className={`text-xs ${todo}`}>Not triaged</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {r.verification ? (
                          <span className={r.verification === "active" ? "text-emerald-800" : todo}>
                            {VERIFICATION_RESULT_LABEL[r.verification]}
                          </span>
                        ) : (
                          <span className={todo}>Not checked</span>
                        )}
                        {r.payerName && <span className="block text-slate-500">{r.payerName}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs tabular">
                        {r.requirementsTotal === 0 ? (
                          <span className="text-slate-400">—</span>
                        ) : r.requirementsOpen === 0 ? (
                          <span className="text-emerald-800">All {r.requirementsTotal} done</span>
                        ) : (
                          <span className={todo}>
                            {r.requirementsOpen} of {r.requirementsTotal} open
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{r.assignedToName ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
