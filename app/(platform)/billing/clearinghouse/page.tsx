/**
 * /billing/clearinghouse — the claim cycle with the clearinghouse (0120):
 * the 837P files Pallio built (sent or downloaded) and what came back for
 * each claim, the response files read, a way to upload one by hand (a 999,
 * TA1, 277CA, 277 or 835 from the clearinghouse's portal), and "check now"
 * for a connection's SFTP folders.
 *
 * Every status here is the clearinghouse's or the payer's own, read from
 * their files, so this page does not carry the "what your team recorded"
 * line (components/billing/submission-disclosure.tsx).
 */
"use client";

import { Download, RefreshCcw, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { fetchConnections, type ConnectionChoice } from "@/components/billing/clearinghouse-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { statusLabel } from "@/lib/features/superbills/superbill-queue";

interface SubmissionClaim {
  superbillId: string;
  claimRef: string;
  visitId: string | null;
  status: string;
  sendState: string;
  ackState: string | null;
  ackErrors: string[];
  payerState: string | null;
  payerStatus: string | null;
  payerSaidBy: "clearinghouse" | "payer" | null;
  payerClaimNumber: string | null;
}

interface Submission {
  id: string;
  vendorName: string;
  connectionLabel: string | null;
  channel: "sftp" | "download";
  usage: "T" | "P";
  filename: string;
  interchangeControlNumber: number;
  claimCount: number;
  state: "sending" | "sent" | "send_failed" | "downloaded";
  ackState: string | null;
  errorMessage: string | null;
  createdAt: string;
  createdByName: string | null;
  claims: SubmissionClaim[];
}

interface ReceivedFile {
  id: string;
  kind: string;
  source: "sftp" | "upload" | "realtime";
  remoteName: string | null;
  connectionLabel: string | null;
  receivedAt: string;
  receivedByName: string | null;
  outcome: "applied" | "nothing_to_apply" | "unmatched" | "failed";
  note: string;
}

const KIND_LABEL: Record<string, string> = {
  "999": "999", ta1: "TA1", "277ca": "277CA", "277": "277", "271": "271", "835": "835",
  notification: "Notice", vendor_report: "Report", unknown: "Unknown",
};
const SEND_LABEL: Record<Submission["state"], string> = {
  sending: "Sending…", sent: "Sent", send_failed: "Not sent", downloaded: "Downloaded",
};
const ACK_LABEL: Record<string, string> = {
  accepted: "accepted", accepted_with_errors: "accepted with errors", partially_accepted: "partly accepted", rejected: "rejected",
};
const OUTCOME_LABEL: Record<ReceivedFile["outcome"], string> = {
  applied: "Applied", nothing_to_apply: "Read", unmatched: "Not matched", failed: "Could not read",
};

export default function ClearinghousePage() {
  const [connections, setConnections] = useState<ConnectionChoice[] | null>(null);
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [files, setFiles] = useState<ReceivedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [perms, setPerms] = useState({ apply: false, admin: false });
  const [polling, setPolling] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadConn, setUploadConn] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([
        fetch("/api/billing/clearinghouse/submissions").then((r) => r.json()),
        fetch("/api/billing/clearinghouse/files").then((r) => r.json()),
      ]);
      if (!s.success || !f.success) throw new Error(s.error ?? f.error ?? "Failed to load.");
      setSubmissions(s.data.submissions);
      setFiles(f.data.files);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void load();
      void fetchConnections().then(setConnections);
      fetch("/api/auth/me")
        .then((r) => r.json())
        .then((d) => {
          const p: string[] = d.data?.permissions ?? [];
          const pa = d.data?.role === "platform_admin";
          setPerms({
            apply: pa || (p.includes("billing.superbills.edit") && p.includes("billing.denials.log")),
            admin: pa || p.includes("settings.integrations"),
          });
        })
        .catch(() => {});
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function poll(c: ConnectionChoice) {
    setPolling(c.id);
    setNote(null);
    try {
      const d = await fetch(`/api/integrations/clearinghouses/${c.id}/poll`, { method: "POST" }).then((r) => r.json());
      if (!d.success) setNote({ ok: false, text: d.error ?? "Couldn't check for responses. Try again." });
      else {
        const r = d.data as { ok: boolean; message: string; files: { name: string; kind: string; note: string }[] };
        setNote({
          ok: r.ok,
          // One line per file, so a check that read many stays readable.
          text: [`${c.label}: ${r.message}`, ...r.files.map((x) => `• ${x.name} (${KIND_LABEL[x.kind] ?? x.kind}): ${x.note}`)].join("\n"),
        });
      }
    } catch {
      setNote({ ok: false, text: "Couldn't reach Pallio, so nothing was checked. Try again." });
    } finally {
      setPolling(null);
      void load();
      void fetchConnections().then(setConnections);
    }
  }

  async function upload(file: File) {
    setUploading(true);
    setNote(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (uploadConn) form.set("connectionId", uploadConn);
      const d = await fetch("/api/billing/clearinghouse/files", { method: "POST", body: form }).then((r) => r.json());
      if (!d.success) setNote({ ok: false, text: d.error ?? "The file wasn't read. Try again." });
      else setNote({ ok: d.data.outcome !== "failed", text: `${file.name} (${KIND_LABEL[d.data.kind] ?? d.data.kind}): ${d.data.note}` });
    } catch {
      setNote({ ok: false, text: "Couldn't reach Pallio, so the file wasn't read. Try again." });
    } finally {
      setUploading(false);
      void load();
    }
  }

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Clearinghouse</h1>
        <p className="mt-1 text-sm text-slate-600">
          Claim files sent to your clearinghouse, and every response: whether the clearinghouse accepted each claim
          (999), whether the payer accepted it (277CA), and the payment (835). A rejected claim goes back to{" "}
          <em>Ready to submit</em>, and its bill says what to fix.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={`mb-4 whitespace-pre-line rounded px-4 py-3 text-sm break-words ${note.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-700"}`}>
          {note.text}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connections</CardTitle>
            <CardDescription>
              {connections === null ? (
                "Loading…"
              ) : connections.length === 0 ? (
                <>
                  No clearinghouse is set up yet.{" "}
                  {perms.admin ? <Link href="/settings/integrations" className="text-[var(--color-brand-700)] hover:underline">Set one up →</Link> : "An admin can set one up in Settings → Integrations."}
                </>
              ) : (
                "Pallio checks each SFTP connection for new responses on a schedule. To check one now, use its button."
              )}
            </CardDescription>
          </CardHeader>
          {connections && connections.length > 0 && (
            <CardContent className="space-y-3">
              {connections.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 last:border-0">
                  <div className="text-sm">
                    <span className="font-medium">{c.label}</span>{" "}
                    <span className="text-xs text-slate-500">
                      {c.vendorName} · {c.environment === "test" ? "test (never reaches a payer)" : "production"} ·{" "}
                      {c.batchChannel === "sftp" ? "sends by SFTP" : "download and upload by hand"}
                      {c.realtimeChannel !== "none" ? ` · real-time checks (${c.realtimeChannel === "core_soap" ? "CAQH CORE" : "Availity API"})` : ""}
                    </span>
                    {c.lastPoll && (
                      <span className={`block text-xs ${c.lastPoll.ok ? "text-slate-500" : "text-red-700"}`}>
                        Last checked {new Date(c.lastPoll.at).toLocaleString()}: {c.lastPoll.message}
                      </span>
                    )}
                  </div>
                  {c.batchChannel === "sftp" && perms.apply && (
                    <Button size="sm" variant="secondary" loading={polling === c.id} disabled={polling !== null} onClick={() => void poll(c)}>
                      <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" /> Check for responses now
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          )}
        </Card>

        {perms.apply && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Upload a response file</CardTitle>
              <CardDescription>
                Downloaded a file from the clearinghouse&rsquo;s website? Upload it here: a 999, TA1, 277CA, 277 or 835.
                Uploading the same file twice is safe: nothing is applied twice, and an 835&rsquo;s held claims are tried again.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              {connections && connections.length > 0 && (
                <select
                  aria-label="Which connection the file came from"
                  value={uploadConn}
                  onChange={(e) => setUploadConn(e.target.value)}
                  className="h-9 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                >
                  <option value="">From any clearinghouse</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
              <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50">
                <Upload aria-hidden="true" className="h-4 w-4" />
                {uploading ? "Reading…" : "Choose file"}
                <input
                  type="file"
                  className="sr-only"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void upload(f);
                  }}
                />
              </label>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Claim files sent</CardTitle>
          <CardDescription>Newest first. Open a file to see where each of its claims stands.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {submissions === null && <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>}
          {submissions?.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No claim files yet. Send or download claims from the Superbills page.</p>
          )}
          {submissions && submissions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">When</th>
                    <th className="px-4 py-2.5 text-left font-semibold">File</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Clearinghouse</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Claims</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {submissions.map((s) => (
                    <SubmissionRows key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Responses received</CardTitle>
          <CardDescription>Every response Pallio has read, from SFTP or uploaded. Only what it said is kept, not the file itself.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {files === null && <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>}
          {files?.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No responses yet. They show here after a check for responses or an upload.</p>
          )}
          {files && files.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">When</th>
                    <th className="px-4 py-2.5 text-left font-semibold">File</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Type</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {files.map((f) => (
                    <tr key={f.id} className="align-top">
                      <td className="px-4 py-2 tabular text-xs text-slate-600">{new Date(f.receivedAt).toLocaleString()}</td>
                      <td className="px-4 py-2 text-xs">
                        <span className="font-mono break-all">{f.remoteName ?? "—"}</span>
                        <span className="block text-slate-500">
                          {f.source === "sftp" ? `from ${f.connectionLabel ?? "SFTP"}` : f.source === "upload" ? `uploaded${f.receivedByName ? ` by ${f.receivedByName}` : ""}` : "real-time"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs">{KIND_LABEL[f.kind] ?? f.kind}</td>
                      <td className="px-4 py-2 text-xs">
                        <span className={f.outcome === "failed" ? "text-red-700" : f.outcome === "unmatched" ? "text-amber-800" : "text-slate-800"}>
                          {OUTCOME_LABEL[f.outcome]}
                        </span>
                        {f.note && <span className="block max-w-xl break-words text-slate-500">{f.note}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** "3 of 4 accepted by Availity": what the clearinghouse said of the file's claims, counted. */
function ackCount(s: Submission): string {
  const answered = s.claims.filter((c) => c.ackState);
  if (answered.length === 0) return "";
  const ok = answered.filter((c) => c.ackState === "accepted" || c.ackState === "accepted_with_errors").length;
  if (ok === s.claims.length) return ` · all accepted by ${s.vendorName}`;
  if (ok === 0) return ` · rejected by ${s.vendorName}`;
  return ` · ${ok} of ${s.claims.length} accepted by ${s.vendorName}`;
}

/** " · 1 rejected by the payer": claims the 277CA turned down after the 999 accepted them. */
function laterRejections(s: Submission): string {
  const rejected = s.claims.filter((c) => c.payerState === "rejected");
  const byVendor = rejected.filter((c) => c.payerSaidBy === "clearinghouse").length;
  const byPayer = rejected.length - byVendor;
  return `${byVendor > 0 ? ` · ${byVendor} later rejected by ${s.vendorName}` : ""}${byPayer > 0 ? ` · ${byPayer} rejected by the payer` : ""}`;
}

function SubmissionRows({ s, open, onToggle }: { s: Submission; open: boolean; onToggle: () => void }) {
  const failed = s.state === "send_failed" || s.ackState === "rejected";
  return (
    <>
      <tr className="align-top hover:bg-slate-50">
        <td className="px-4 py-2 tabular text-xs text-slate-600">
          {new Date(s.createdAt).toLocaleString()}
          {s.createdByName && <span className="block">{s.createdByName}</span>}
        </td>
        <td className="px-4 py-2 text-xs">
          <button type="button" onClick={onToggle} aria-expanded={open} className="break-all text-left font-mono text-[var(--color-brand-700)] hover:underline">
            {s.filename}
          </button>
          <span className="block text-slate-500">
            interchange {String(s.interchangeControlNumber).padStart(9, "0")}
            {s.usage === "T" ? " · test file (never reaches a payer)" : ""}
          </span>
        </td>
        <td className="px-4 py-2 text-xs">
          {s.vendorName}
          {s.connectionLabel && <span className="block text-slate-500">{s.connectionLabel}</span>}
        </td>
        <td className="px-4 py-2 text-right tabular text-xs">{s.claimCount}</td>
        <td className="px-4 py-2 text-xs">
          <span className={failed ? "text-red-700" : undefined}>
            {s.channel === "download" ? <Download aria-hidden="true" className="mr-1 inline h-3 w-3" /> : null}
            {SEND_LABEL[s.state]}
            {ackCount(s)}
          </span>
          {laterRejections(s) && <span className="text-red-700">{laterRejections(s)}</span>}
          {s.errorMessage && <span className="block max-w-md text-red-700">{s.errorMessage}</span>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-4 py-2">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 text-left font-medium">Claim</th>
                  <th className="py-1 text-left font-medium">Status in Pallio</th>
                  <th className="py-1 text-left font-medium">{s.vendorName} (999)</th>
                  <th className="py-1 text-left font-medium">Claim acknowledgment (277CA)</th>
                </tr>
              </thead>
              <tbody>
                {s.claims.map((c) => (
                  <tr key={c.superbillId} className="align-top">
                    <td className="py-1 font-mono">
                      {c.visitId ? (
                        <Link href={`/visits/${c.visitId}/superbill`} className="text-[var(--color-brand-700)] hover:underline">{c.claimRef}</Link>
                      ) : (
                        c.claimRef
                      )}
                    </td>
                    <td className="py-1">{statusLabel(c.status)}</td>
                    <td className={`py-1 ${c.ackState === "rejected" ? "text-red-700" : ""}`}>
                      {c.ackState ? ACK_LABEL[c.ackState] ?? c.ackState : "—"}
                      {c.ackErrors.map((e) => (
                        <span key={e} className="block">{e}</span>
                      ))}
                    </td>
                    <td className={`py-1 ${c.payerState === "rejected" ? "text-red-700" : ""}`}>
                      {c.payerStatus ?? "—"}
                      {c.payerClaimNumber && <span className="block text-slate-500">payer claim # {c.payerClaimNumber}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
