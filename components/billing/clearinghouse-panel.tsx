/**
 * A bill's clearinghouse card (0120): where the claim stands with the
 * clearinghouse and the payer, and the three things a biller does from here —
 * send it (over the connection's SFTP), download its 837P to upload by hand,
 * and ask the payer where it stands (276/277).
 *
 * Shown only once a connection exists; the queue does the same for many
 * claims at once. What the clearinghouse said is printed as the server
 * summarised it, so this card and the queue never word it differently.
 */
"use client";

import { RefreshCcw, Send } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EXPORTABLE_STATUSES } from "@/lib/features/billing/claim-export";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";

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
} from "./clearinghouse-client";

const SENDABLE = ["ready_to_submit", "denied"];
const ASKABLE = ["submitted", "partially_paid", "denied", "paid"];
/** A bill whose coverage can still be corrected (the editable statuses). */
const CORRECTABLE = ["draft", "ready_to_submit", "denied"];

export function ClearinghousePanel({
  superbillId,
  status,
  disabled,
  onChanged,
}: {
  superbillId: string;
  status: string | null;
  /** Unsaved edits on the page: the file would not carry them. */
  disabled: boolean;
  /** After a send or an answer: the page reads its status and history again. */
  onChanged: () => void;
}) {
  const [perms, setPerms] = useState<{ export: boolean; edit: boolean }>({ export: false, edit: false });
  const [connections, setConnections] = useState<ConnectionChoice[]>([]);
  const [connectionId, setConnectionId] = useState("");
  /** undefined until the first answer: the card does not say "not sent" before it knows. */
  const [current, setCurrent] = useState<ClaimClearinghouseStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState<"send" | "download" | "status" | "insurance" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const p: string[] = d.data?.permissions ?? [];
        const admin = d.data?.role === "platform_admin";
        setPerms({ export: admin || p.includes("billing.superbills.export"), edit: admin || p.includes("billing.superbills.edit") });
      })
      .catch(() => {});
    void fetchConnections().then((cs) => {
      setConnections(cs);
      setConnectionId(defaultConnection(cs)?.id ?? "");
    });
  }, []);

  useEffect(() => {
    let abandoned = false;
    void fetchClaimStatuses([superbillId]).then((s) => {
      if (!abandoned) setCurrent(s[superbillId] ?? null);
    });
    return () => {
      abandoned = true;
    };
  }, [superbillId, status, reload]);

  const connection = connections.find((c) => c.id === connectionId) ?? null;
  if (connections.length === 0 || !connection) return null;

  async function act(kind: "send" | "download" | "status") {
    if (!connection) return;
    if (kind === "send" && !confirm(sendQuestion(connection, [claimRefFor(superbillId)]))) return;
    setBusy(kind);
    setNote(null);
    try {
      if (kind === "status") {
        const r = await fetch(`/api/superbills/${superbillId}/claim-status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId: connection.id }),
        });
        const d = await r.json();
        setNote(
          d.success
            ? {
                ok: true,
                text: d.data.statuses.length > 0
                  ? `The payer says: ${(d.data.statuses as { text: string }[]).map((s) => s.text).join("; ")}${d.data.payerClaimNumber ? ` · payer claim # ${d.data.payerClaimNumber}` : ""}. Saved on the claim's history.`
                  : "The payer had no status for this claim yet. Try again in a day or two.",
              }
            : { ok: false, text: d.error ?? "Couldn't get the claim's status from the payer. Try again." },
        );
      } else {
        setNote(kind === "send" ? await sendClaims(connection, [superbillId]) : await downloadClaimFile(connection, [superbillId]));
      }
    } catch {
      setNote({ ok: false, text: "Couldn't reach Pallio. Check your connection and try again." });
    } finally {
      setBusy(null);
      setReload((n) => n + 1);
      onChanged();
    }
  }

  /**
   * After a rejection for the member ID or the plan (277CA A7:33 and its
   * kind): the chart has been corrected, and the bill takes it. The page
   * reloads whole, since the plan, the price and the status can all change.
   */
  async function takeChartInsurance() {
    setBusy("insurance");
    setNote(null);
    try {
      const d = await fetch(`/api/superbills/${superbillId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { refreshInsurance: true } }),
      }).then((r) => r.json());
      if (!d.success) {
        setNote({ ok: false, text: d.error ?? "The insurance wasn't updated. Try again." });
        return;
      }
      if (!d.data.updated) {
        setNote({ ok: true, text: "Nothing to update: the bill already has the chart's plan and member ID." });
        return;
      }
      window.location.reload();
    } catch {
      setNote({ ok: false, text: "Couldn't reach Pallio, so the insurance wasn't updated. Try again." });
    } finally {
      setBusy(null);
    }
  }

  const rejected = current?.payerState === "rejected" || current?.ackState === "rejected";
  return (
    <Card className="mt-6" severity={rejected ? "warn" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send aria-hidden="true" className="h-4 w-4" /> Clearinghouse
        </CardTitle>
        <CardDescription>
          {current === undefined ? (
            "Checking…"
          ) : current ? (
            <>
              <span className={rejected ? "text-red-700" : undefined}>{current.summary}</span>
              <span className="block text-xs text-slate-500">
                {current.filename}, {new Date(current.sentAt).toLocaleString()}
              </span>
            </>
          ) : (
            "Not sent through a clearinghouse yet."
          )}
        </CardDescription>
        {current?.nextStep && (
          <p className="mt-1 text-sm text-slate-800">
            <span className="font-medium">What to do: </span>
            {current.nextStep}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {connections.length > 1 && (
          <select
            aria-label="Clearinghouse"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            className="h-9 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {connectionName(c)}
              </option>
            ))}
          </select>
        )}
        {perms.export && perms.edit && connection.batchChannel === "sftp" && status && SENDABLE.includes(status) && (
          <Button size="sm" loading={busy === "send"} disabled={disabled || busy !== null} onClick={() => void act("send")}>
            Send to {connection.vendorName}
          </Button>
        )}
        {perms.export && status && (EXPORTABLE_STATUSES as readonly string[]).includes(status) && (
          <Button size="sm" variant="secondary" loading={busy === "download"} disabled={disabled || busy !== null} onClick={() => void act("download")}>
            Download 837P
          </Button>
        )}
        {perms.edit && status && CORRECTABLE.includes(status) && (
          <Button size="sm" variant="secondary" loading={busy === "insurance"} disabled={disabled || busy !== null} onClick={() => void takeChartInsurance()}>
            Update insurance from chart
          </Button>
        )}
        {perms.edit && connection.realtimeChannel !== "none" && status && ASKABLE.includes(status) && (
          <Button size="sm" variant="secondary" loading={busy === "status"} disabled={busy !== null} onClick={() => void act("status")}>
            <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" /> Check claim status
          </Button>
        )}
        <Link href="/billing/clearinghouse" className="text-xs text-[var(--color-brand-700)] hover:underline">
          Claim files and responses →
        </Link>
        {note && (
          <p role={note.ok ? "status" : "alert"} className={`basis-full whitespace-pre-line break-words text-sm ${note.ok ? "text-emerald-800" : "text-red-700"}`}>
            {note.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
