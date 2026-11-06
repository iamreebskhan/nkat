/** /billing/superbills — superbill queue + status filters + transitions. */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { askReason } from "@/components/billing/ask-reason";
import {
  connectionName,
  defaultConnection,
  downloadClaimFile,
  fetchClaimStatuses,
  fetchConnections,
  sendClaims,
  sendQuestion,
  type ClaimClearinghouseStatus,
  type ConnectionChoice,
} from "@/components/billing/clearinghouse-client";
import { CodeList } from "@/components/billing/code-list";
import { SubmissionDisclosure } from "@/components/billing/submission-disclosure";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pager } from "@/components/ui/pager";
import { EXPORTABLE_STATUSES } from "@/lib/features/billing/claim-export";
import { usePracticeDate } from "@/lib/features/schedule/use-practice-zone";
import {
  FURTHER_PAYMENT_LABEL,
  QUEUE_ACTIONS,
  QUEUE_STATUSES,
  furtherPaymentTotal,
  paidInFullConfirmText,
  parseStatusParam,
  statusLabel,
  type QueueAction,
  type QueueFilter,
} from "@/lib/features/superbills/superbill-queue";

interface SuperbillRow {
  id: string;
  visitId: string;
  patientId: string;
  /** Joined on the server so a row says whose claim it is (audit R16). */
  patientName: string;
  /** The rendering clinician named on the claim. */
  providerName: string;
  status: string;
  dateOfService: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
  /** 'remittance' when a payer's 835 posted the amount (audit R10). */
  paidSource?: "recorded" | "remittance" | null;
  /**
   * Entered as the patient account no. (CMS-1500 box 26) when the claim goes
   * out, so the payer's 835 matches back to this bill (audit R10).
   */
  claimRef: string;
  /** Always on the API row; this screen simply never rendered it before. */
  cptCodes: string[];
  /** From the rulebook-fed code table; null for a code not in it. */
  codeDescriptors?: Record<string, string | null>;
  /** Sent to billing: the claim's last export (0118). */
  lastExportedAt?: string | null;
}

const exportable = (status: string) => (EXPORTABLE_STATUSES as readonly string[]).includes(status);

/** Hands the browser the exported file. */
function saveCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type Filter = QueueFilter;

const PAGE_SIZE = 50;

/**
 * One page of the queue. The status filter and the paging both run on the
 * server: this used to fetch the newest 50 rows, filter those here, and print
 * their count as the size of the queue — so row 51 was unreachable and every
 * chip under-counted (audit R34).
 */
async function fetchPage(filter: Filter, page: number): Promise<{ rows: SuperbillRow[]; total: number }> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (filter !== "all") params.set("status", filter);
  const d = await fetch(`/api/superbills?${params.toString()}`).then((r) => r.json());
  if (!d.success) throw new Error(d.error ?? "Failed.");
  return { rows: d.data?.rows ?? [], total: Number(d.data?.total ?? 0) };
}

export default function SuperbillsPage() {
  const [rows, setRows] = useState<SuperbillRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The day a claim was sent to billing, on the practice's calendar.
  const atPracticeDay = usePracticeDate();
  // Claims picked for export to the billing software (0118, Mark Q1 default),
  // offered to whoever holds the export grant the route enforces.
  const [canExport, setCanExport] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Clearinghouse connections (0120): the picked claims can be sent through
  // one, or built into its 837P to upload by hand. What each claim's
  // clearinghouse said last shows under its status.
  const [connections, setConnections] = useState<ConnectionChoice[]>([]);
  const [connectionId, setConnectionId] = useState<string>("");
  const [sending, setSending] = useState<"send" | "download" | null>(null);
  const [chStatus, setChStatus] = useState<Record<string, ClaimClearinghouseStatus>>({});
  const connection = connections.find((c) => c.id === connectionId) ?? null;
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const perms: string[] = d.data?.permissions ?? [];
        const can = Boolean(d.success) && (perms.includes("billing.superbills.export") || d.data?.role === "platform_admin");
        setCanExport(can);
        if (can) {
          void fetchConnections().then((cs) => {
            setConnections(cs);
            setConnectionId(defaultConnection(cs)?.id ?? "");
          });
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    let abandoned = false;
    void fetchClaimStatuses(rows.map((r) => r.id)).then((s) => {
      if (!abandoned) setChStatus(s);
    });
    return () => {
      abandoned = true;
    };
  }, [rows]);

  async function clearinghouse(kind: "send" | "download") {
    if (!connection) return;
    if (kind === "send" && !confirm(sendQuestion(connection, rows.filter((r) => picked.includes(r.id)).map((r) => r.claimRef)))) return;
    setSending(kind);
    setExportNote(null);
    const out = kind === "send" ? await sendClaims(connection, picked) : await downloadClaimFile(connection, picked);
    setExportNote(out);
    if (out.ok) setPicked([]);
    try {
      const fresh = await fetchPage(filter, page);
      setRows(fresh.rows);
      setTotal(fresh.total);
    } catch {
      // The note above stands; the list refreshes on the next load.
    } finally {
      setSending(null);
    }
  }

  async function exportPicked() {
    setExporting(true);
    setExportNote(null);
    try {
      const r = await fetch("/api/billing/claim-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ superbillIds: picked }),
      });
      const d = await r.json();
      if (!d.success) {
        setExportNote({ ok: false, text: d.error ?? "Not exported." });
        return;
      }
      saveCsv(d.data.filename, d.data.csv);
      const warned = (d.data.warnings as { claimRef: string; warnings: string[] }[])
        .map((w) => `${w.claimRef}: ${w.warnings.join(", ")}`)
        .join("; ");
      setExportNote({
        ok: true,
        text: `Exported ${d.data.claims} claim${d.data.claims === 1 ? "" : "s"} (${d.data.lines} line${d.data.lines === 1 ? "" : "s"}) as ${d.data.filename}, and marked sent to billing.${warned ? ` Still missing — ${warned}.` : ""}`,
      });
      setPicked([]);
      const fresh = await fetchPage(filter, page);
      setRows(fresh.rows);
      setTotal(fresh.total);
    } catch {
      setExportNote({ ok: false, text: "Network error — not exported." });
    } finally {
      setExporting(false);
    }
  }
  // The pipeline chips on /billing link here with ?status=… (audit R26); the
  // filter used to start at "all" whatever the link said. Read once, from a
  // timer rather than synchronously in the effect body, and hold the first
  // fetch until it has been read so the list does not load twice.
  const [urlRead, setUrlRead] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      const s = parseStatusParam(window.location.search);
      if (s !== "all") setFilter(s);
      setUrlRead(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!urlRead) return;
    let abandoned = false;
    (async () => {
      try {
        const r = await fetchPage(filter, page);
        if (abandoned) return;
        setError(null);
        setRows(r.rows);
        setTotal(r.total);
      } catch (e) {
        if (!abandoned) setError(e instanceof Error ? e.message : "Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [filter, page, urlRead]);

  async function transition(row: SuperbillRow, action: QueueAction) {
    let paidAmountCents: number | undefined;
    // The status the move records. Usually the button's own, but a typed
    // amount that covers the whole bill is a payment in full whichever button
    // asked for it — see the prompt path below.
    let to: QueueAction["to"] = action.to;
    // Sent only when the biller has been shown both figures and said the payer
    // really did pay more than the claim billed; the server refuses the move
    // without it.
    let overpaymentAcknowledged = false;
    if (action.amount === "billed") {
      // Paid = billed is rarely true once contractual adjustments apply, and
      // this used to be written on one unconfirmed click (audit R35).
      // Cancelling leaves the claim where it was.
      if (!confirm(paidInFullConfirmText(row.billedAmountCents))) return;
      paidAmountCents = row.billedAmountCents;
    }
    if (action.amount === "prompt") {
      const billed = `$${(row.billedAmountCents / 100).toFixed(2)}`;
      // The prompt used to name no format, so 5000 for $50.00 looked like a
      // reasonable thing to type.
      const v = prompt(
        `Amount the payer paid, from the EOB or remittance — in dollars and cents, so $50.00 is 50.00.\n\nThis claim billed ${billed}.`,
        "",
      );
      if (v === null || v.trim() === "") return; // cancelled / empty ≠ $0.00
      const dollars = Number(v.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(dollars) || dollars < 0) {
        alert("Enter a valid dollar amount — in dollars and cents, for example 50.00.");
        return;
      }
      const cents = Math.round(dollars * 100);
      const typed = `$${(cents / 100).toFixed(2)}`;
      // Echo the parsed amount back before it is written, the way "Record paid
      // in full" does. A cents/dollars slip went straight to the API on one
      // click: nothing here compared it to the claim, and the biller never saw
      // the figure they had just typed (audit R35).
      // Named for the payment, not the bill: "over billed" reads as the
      // provider having billed too much, which is not what this tests.
      const aboveBill = row.billedAmountCents > 0 && cents > row.billedAmountCents;
      // An unpriced claim (billed 0) has no bill to cover, so nothing here is
      // "in full" and the amount stays a partial payment.
      const coversBill = row.billedAmountCents > 0 && cents >= row.billedAmountCents;
      if (
        !confirm(
          aboveBill
            ? `${typed} is more than the ${billed} billed on this claim.\n\nRecord it anyway, as paid with the overpayment confirmed? Cancel if you meant to type dollars and cents — $50.00 is 50.00, not 5000.`
            : coversBill
              ? `${typed} is the whole ${billed} billed on this claim, so it is recorded as paid in full.\n\nRecord it?`
              : `Record a partial payment of ${typed} on this claim (billed ${billed})?`,
        )
      ) {
        return;
      }
      paidAmountCents = cents;
      overpaymentAcknowledged = aboveBill;
      // The button says "Record partial payment" and points at partially_paid,
      // but an amount that covers the bill is not a partial payment: it left
      // the claim in the queue's "partially paid" filter and in /billing's
      // Outstanding (billed − paid, which an overpayment drove negative), and
      // one above the bill wrote a trail line contradicting itself — "Recorded
      // as partially paid … more than the $150.00 billed". The service now
      // refuses that pairing, so the status follows the figure.
      if (coversBill) to = "paid";
    }
    setBusyId(row.id);
    try {
      const send = async (extra: Record<string, unknown> = {}) => {
        const r = await fetch(`/api/superbills/${row.id}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            to,
            ...(paidAmountCents !== undefined ? { paidAmountCents } : {}),
            ...(overpaymentAcknowledged ? { overpaymentAcknowledged: true } : {}),
            // Every "paid" this screen posts is the same assertion — that the
            // amount covers the whole bill — made against `row`, which is a
            // fetched copy: "Record paid in full" posts the row's billed
            // figure, and a typed amount that reaches it is recorded as paid
            // above. A claim repriced and resubmitted in another tab leaves
            // this row lower than the claim, and 'paid' is terminal, so the
            // service re-checks the assertion against the claim itself and
            // refuses rather than closing a bill that is not covered.
            ...(to === "paid" ? { paidInFull: true } : {}),
            ...extra,
          }),
        });
        return r.json();
      };
      let d = await send();
      // The payer's documentation standard says the note lacks something
      // (audit R19). Submitting anyway is the biller's call, with a reason the
      // claim history keeps; cancelling leaves the claim where it was.
      if (!d.success && d.data?.documentationIncomplete) {
        const reason = askReason(
          `${d.error}\n\nTo record it as submitted anyway, enter the reason (at least 10 characters). It is recorded on the claim history.`,
        );
        if (reason === null) return;
        d = await send({ documentationOverride: { reason } });
      }
      if (!d.success) {
        alert(d.error ?? "Transition failed.");
        return;
      }
      // Keep the row's buttons disabled until the fresh status renders.
      const fresh = await fetchPage(filter, page);
      // The row may have left this filter and emptied the last page.
      if (fresh.rows.length === 0 && page > 0) setPage(page - 1);
      else {
        setRows(fresh.rows);
        setTotal(fresh.total);
      }
    } catch {
      alert("Network error — status not changed.");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Another payment on a partially paid claim (D9): added to what is recorded.
   * Below the bill it asks whether the claim closes there, because most do: the
   * rest is a contractual adjustment or the patient's, and left open it would
   * show a balance nobody owes.
   */
  async function furtherPayment(row: SuperbillRow) {
    const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    const paidCents = row.paidAmountCents ?? 0;
    const billed = usd(row.billedAmountCents);
    const v = prompt(
      `Amount of this payment, from the EOB or remittance — in dollars and cents, so $50.00 is 50.00.\n\n${usd(paidCents)} of the ${billed} billed is recorded so far.`,
      "",
    );
    if (v === null || v.trim() === "") return;
    const entered = Number(v.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(entered) || entered <= 0) {
      alert("Enter a valid dollar amount — in dollars and cents, for example 50.00.");
      return;
    }
    const amountCents = Math.round(entered * 100);
    const { totalCents, above, covers } = furtherPaymentTotal({ paidCents, billedCents: row.billedAmountCents, amountCents });
    const added = `${usd(amountCents)} on top of the ${usd(paidCents)} recorded makes ${usd(totalCents)}`;
    if (
      !confirm(
        above
          ? `${added}, more than the ${billed} billed on this claim.\n\nRecord it anyway, as paid with the overpayment confirmed? Cancel if you meant to type dollars and cents — $50.00 is 50.00, not 5000.`
          : covers
            ? `${added}, the whole ${billed} billed, so it is recorded as paid in full.\n\nRecord it?`
            : `${added} of the ${billed} billed.\n\nRecord it?`,
      )
    ) {
      return;
    }
    const last =
      !covers &&
      confirm(
        `Is this the last payment on this claim?\n\nOK closes it as paid at ${usd(totalCents)}: the rest is a contractual adjustment or the patient's.\n\nCancel keeps it partially paid, open for another payment. The ${usd(amountCents)} is recorded either way.`,
      );
    setBusyId(row.id);
    try {
      const d = await fetch(`/api/superbills/${row.id}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents, ...(last ? { last: true } : {}), ...(above ? { overpaymentAcknowledged: true } : {}) }),
      }).then((r) => r.json());
      if (!d.success) {
        alert(d.error ?? "The payment was not recorded.");
        return;
      }
      const fresh = await fetchPage(filter, page);
      if (fresh.rows.length === 0 && page > 0) setPage(page - 1);
      else {
        setRows(fresh.rows);
        setTotal(fresh.total);
      }
    } catch {
      alert("Network error — the payment was not recorded.");
    } finally {
      setBusyId(null);
    }
  }

  const from = page * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE + rows.length;

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Superbills</h1>
        {/* Every status and paid amount in this queue is the team's own record
            of what happened in its clearinghouse or payer portal (audit R35). */}
        <SubmissionDisclosure />
      </header>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle>Queue</CardTitle>
            <div className="flex gap-1 flex-wrap">
              {QUEUE_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setFilter(s);
                    setPage(0);
                    // Keep the URL in step so the view can be linked and reloaded.
                    window.history.replaceState(
                      null,
                      "",
                      s === "all" ? "/billing/superbills" : `/billing/superbills?status=${s}`,
                    );
                  }}
                  className={`px-3 py-1 rounded text-xs ${
                    filter === s
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {statusLabel(s)}
                </button>
              ))}
            </div>
          </div>
          <CardDescription>
            {total === 0
              ? "No superbills"
              : `Showing ${from}–${to} of ${total} superbill${total === 1 ? "" : "s"}`}
          </CardDescription>
          {canExport && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" variant="secondary" disabled={picked.length === 0} loading={exporting} onClick={() => void exportPicked()}>
                Export {picked.length > 0 ? `${picked.length} ` : ""}for billing (CSV)
              </Button>
              <span className="text-xs text-slate-500">
                Reviewed claims only. Each one exported is marked sent to billing; its status does not change.
              </span>
            </div>
          )}
          {canExport && connections.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {connections.length > 1 ? (
                <select
                  aria-label="Clearinghouse"
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className="h-8 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {connectionName(c)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-slate-700">{connection ? connectionName(connection) : null}</span>
              )}
              {connection?.batchChannel === "sftp" && (
                <Button size="sm" disabled={picked.length === 0 || sending !== null} loading={sending === "send"} onClick={() => void clearinghouse("send")}>
                  Send {picked.length > 0 ? `${picked.length} ` : ""}to {connection.vendorName}
                </Button>
              )}
              <Button size="sm" variant="secondary" disabled={picked.length === 0 || sending !== null} loading={sending === "download"} onClick={() => void clearinghouse("download")}>
                Download 837P{picked.length > 0 ? ` (${picked.length})` : ""}
              </Button>
              <span className="text-xs text-slate-500">
                {connection?.batchChannel === "sftp"
                  ? connection.environment === "test"
                    ? `Test connection: ${connection.vendorName} checks the file but never passes it to a payer, so nothing is marked Submitted.`
                    : `Send uploads the picked claims to ${connection.vendorName} and marks them Submitted. Only claims that are ready to submit, or denied and corrected, can be sent.`
                  : `Download creates the 837P file for you to upload in ${connection?.vendorName ?? "the clearinghouse"} yourself.`}
              </span>
            </div>
          )}
          {exportNote && (
            <p role={exportNote.ok ? "status" : "alert"} className={`whitespace-pre-line break-words text-sm ${exportNote.ok ? "text-emerald-800" : "text-red-700"}`}>
              {exportNote.text}
            </p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">{error}</p>
          )}
          {loading && <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>}
          {!loading && rows.length === 0 && !error && (
            <p className="px-4 py-12 text-center text-sm text-slate-500">No superbills match this filter.</p>
          )}
          {rows.length > 0 && (
            // Wide on purpose once codes are in it — scrolls inside the card
            // rather than pushing the page sideways on a tablet.
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <tr>
                    {canExport && (
                      <th className="px-2 py-2.5">
                        <span className="sr-only">Select claims to export or send</span>
                      </th>
                    )}
                    <th className="text-left font-semibold px-4 py-2.5">DOS</th>
                    {/* The short ref a payer's 835 echoes back (audit R10). */}
                    <th className="text-left font-semibold px-4 py-2.5">Claim ref</th>
                    <th className="text-left font-semibold px-4 py-2.5">Patient</th>
                    <th className="text-left font-semibold px-4 py-2.5">Clinician</th>
                    <th className="text-left font-semibold px-4 py-2.5">Codes</th>
                    <th className="text-left font-semibold px-4 py-2.5">Status</th>
                    <th className="text-right font-semibold px-4 py-2.5">Billed</th>
                    <th className="text-right font-semibold px-4 py-2.5">Paid</th>
                    <th className="text-right font-semibold px-4 py-2.5">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50 align-top">
                      {canExport && (
                        <td className="px-2 py-2">
                          {exportable(s.status) && (
                            <input
                              type="checkbox"
                              aria-label={`Select claim ${s.claimRef}`}
                              checked={picked.includes(s.id)}
                              onChange={(e) =>
                                setPicked((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))
                              }
                            />
                          )}
                        </td>
                      )}
                      <td className="px-4 py-2 tabular text-slate-700">{s.dateOfService.slice(0, 10)}</td>
                      <td
                        className="px-4 py-2 font-mono text-xs text-slate-700"
                        title="Enter this as the Patient account no. (CMS-1500 box 26) when you submit the claim, so the payer's 835 matches back to this bill."
                      >
                        {s.claimRef}
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/patients/${s.patientId}`}
                          className="text-[var(--color-brand-700)] hover:underline"
                        >
                          {s.patientName || "—"}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-slate-700">{s.providerName || "—"}</td>
                      <td className="px-4 py-2">
                        <CodeList codes={s.cptCodes} descriptors={s.codeDescriptors} />
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {statusLabel(s.status)}
                        {s.lastExportedAt && (
                          <span className="block text-slate-500">
                            sent to billing {atPracticeDay(s.lastExportedAt)}
                          </span>
                        )}
                        {chStatus[s.id] && (
                          <span
                            className={`block max-w-xs ${chStatus[s.id]!.payerState === "rejected" || chStatus[s.id]!.ackState === "rejected" ? "text-red-700" : "text-slate-500"}`}
                          >
                            {chStatus[s.id]!.summary}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular">${(s.billedAmountCents / 100).toFixed(2)}</td>
                      <td className="px-4 py-2 text-right tabular">
                        {s.paidAmountCents == null ? "—" : `$${(s.paidAmountCents / 100).toFixed(2)}`}
                        {/* Posted from the payer's own 835, not typed (audit R10). */}
                        {s.paidSource === "remittance" && (
                          <span className="text-xs text-slate-500"> · remittance</span>
                        )}
                        {/* A payment above what the claim billed is said where
                            the money is. /audit names it too now, but that is
                            the auditor's screen and this is the one a biller
                            scans down. The test is the two amounts and nothing
                            else — a typed amount confirmed as an overpayment
                            and a payer's 835, which markStatusTx never bounds,
                            both land here — so it says what the figures show
                            rather than whose word the figure is. Not "over
                            billed": that reads as the provider having billed
                            too much, which is a different accusation entirely. */}
                        {s.paidAmountCents !== null &&
                          s.paidAmountCents !== undefined &&
                          s.billedAmountCents > 0 &&
                          s.paidAmountCents > s.billedAmountCents && (
                            <span className="text-xs text-amber-800"> · more than billed</span>
                          )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex justify-end items-center gap-1.5 flex-wrap">
                          {/* A draft is reviewed on its bill page, where the
                              bill and its rule check are on screen (R26). */}
                          <Link
                            href={`/visits/${s.visitId}/superbill`}
                            className="px-2 py-0.5 text-xs text-[var(--color-brand-700)] hover:underline"
                          >
                            {s.status === "draft" ? "Review →" : "Open →"}
                          </Link>
                          {(QUEUE_ACTIONS[s.status] ?? []).map((a) => (
                            <button
                              key={a.to + a.label}
                              type="button"
                              disabled={busyId === s.id}
                              onClick={() => void transition(s, a)}
                              className="px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                            >
                              {a.label}
                            </button>
                          ))}
                          {s.status === "partially_paid" && (
                            <button
                              type="button"
                              disabled={busyId === s.id}
                              onClick={() => void furtherPayment(s)}
                              className="px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                            >
                              {FURTHER_PAYMENT_LABEL}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {total > PAGE_SIZE && (
            <Pager page={page} pageSize={PAGE_SIZE} total={total} shown={rows.length} onPage={setPage} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
