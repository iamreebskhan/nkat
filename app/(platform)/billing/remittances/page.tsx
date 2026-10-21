/**
 * /billing/remittances — upload a payer's ERA/835 (audit R10).
 *
 * Every paid amount and denial in Pallio used to be typed by the team. This is
 * where the payer's own file comes in: upload the 835 the clearinghouse or the
 * payer's portal gives you, and its payments and denials post to the bills
 * they match, citing the file. Pallio fetches nothing itself (R35).
 *
 * A claim matches by its Claim ref, the bill's short reference entered as the
 * patient account no. (box 26) when the claim was submitted. What cannot post
 * (no match, a reversal, a bill still in draft) is listed for a person, and
 * uploading the same file again retries only those.
 */
"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { localDateKey } from "@/lib/features/visits/visit-pure";

type Posting = "paid" | "partially_paid" | "denied" | "unmatched" | "needs_review";

interface Counts {
  claims: number;
  paid: number;
  partiallyPaid: number;
  denied: number;
  unmatched: number;
  needsReview: number;
  errors: number;
  alreadyPosted: number;
  paidCents: number;
}

interface Report {
  fileId: string;
  alreadyUploaded: boolean;
  counts: Counts;
  unmatched: { claimId: string; dos: string | null; billedCents: number; paidCents: number }[];
  needsReview: { claimId: string; note: string }[];
  errors: { claimId: string; message: string }[];
}

interface FileRow {
  id: string;
  filename: string;
  payerName: string | null;
  traceNumber: string | null;
  paymentDate: string | null;
  totalPaidCents: number | null;
  claimCount: number;
  uploadedAt: string;
  uploadedBy: string | null;
  counts: { paid: number; partiallyPaid: number; denied: number; unmatched: number; needsReview: number };
}

interface LineRow {
  claimSeq: number;
  lineSeq: number;
  claimId: string | null;
  dateOfService: string | null;
  billedCents: number | null;
  paidCents: number | null;
  carcCodes: string[];
  rarcCodes: string[];
  groupCode: string | null;
  serviceCodes: string[];
  modifiers: string[];
  posting: Posting;
  postingNote: string | null;
  claimRef: string | null;
  visitId: string | null;
}

const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "—" : `$${(cents / 100).toFixed(2)}`;

const POSTING: Record<Posting, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
  partially_paid: { label: "Partially paid", cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
  denied: { label: "Denied", cls: "bg-red-50 text-red-800 ring-red-600/30" },
  unmatched: { label: "Unmatched", cls: "bg-slate-100 text-slate-700 ring-slate-600/20" },
  needs_review: { label: "Needs review", cls: "bg-amber-50 text-amber-800 ring-amber-600/30" },
};

/** "1 claim · 1 denied · 0 unmatched": what happened, and always the unmatched count. */
function summaryLine(c: Counts): string {
  return [
    `${c.claims} claim${c.claims === 1 ? "" : "s"}`,
    c.paid > 0 && `${c.paid} paid`,
    c.partiallyPaid > 0 && `${c.partiallyPaid} partially paid`,
    c.denied > 0 && `${c.denied} denied`,
    `${c.unmatched} unmatched`,
    c.needsReview > 0 && `${c.needsReview} ${c.needsReview === 1 ? "needs" : "need"} review`,
    c.errors > 0 && `${c.errors} failed`,
    c.alreadyPosted > 0 && `${c.alreadyPosted} already posted`,
    c.paidCents > 0 && `${money(c.paidCents)} posted`,
  ]
    .filter(Boolean)
    .join(" · ");
}

async function fetchFiles(): Promise<FileRow[]> {
  const d = await fetch("/api/remittances").then((r) => r.json());
  if (!d.success) throw new Error(d.error ?? "Failed to load remittances.");
  return d.data?.files ?? [];
}

export default function RemittancesPage() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, LineRow[]>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  // Async IIFE with an abandon flag: no synchronous setState in the effect.
  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const f = await fetchFiles();
        if (abandoned) return;
        setFiles(f);
        setError(null);
      } catch (e) {
        if (!abandoned) setError(e instanceof Error ? e.message : "Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, []);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setReport(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const d = await fetch("/api/remittances", { method: "POST", body: form }).then((r) => r.json());
      if (!d.success) {
        setUploadError(d.error ?? "Upload failed.");
        return;
      }
      setReport(d.data);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      // A retry changes an earlier file's lines, so drop what was loaded.
      setLines({});
      setOpenId(null);
      setFiles(await fetchFiles());
    } catch {
      setUploadError("Network error. Upload the file again: anything already posted is skipped.");
    } finally {
      setUploading(false);
    }
  }

  async function toggle(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (lines[id]) return;
    try {
      const d = await fetch(`/api/remittances/${id}`).then((r) => r.json());
      if (d.success) setLines((m) => ({ ...m, [id]: d.data?.lines ?? [] }));
      else setError(d.error ?? "Failed to load the file's lines.");
    } catch {
      setError("Network error.");
    }
  }

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <Link href="/billing" className="text-xs text-slate-500 hover:underline">
          ← Billing
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">Remittances</h1>
        <p className="text-slate-600 mt-1">
          Upload the 835 (ERA) file your clearinghouse or the payer&rsquo;s portal gives you. The
          payments and denials in it post to the bills they match, citing the file.
        </p>
        <p className="mt-1 text-sm text-slate-500">
          So the file can match back: when you submit a claim, enter the bill&rsquo;s{" "}
          <span className="font-medium text-slate-700">Claim ref</span> as the Patient account no.
          (CMS-1500 box 26). It is on the Superbills queue, the bill page and the PDF.
        </p>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Upload an 835</CardTitle>
          <CardDescription>Uploading the same file again re-tries only what did not post.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={upload} className="flex flex-wrap items-center gap-3">
            <label htmlFor="era-file" className="text-sm text-slate-700">
              835 file
            </label>
            <input
              ref={inputRef}
              id="era-file"
              type="file"
              accept=".835,.txt,.edi,.x12"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm hover:file:bg-slate-50"
            />
            <Button type="submit" loading={uploading} disabled={!file || uploading}>
              Upload and post
            </Button>
          </form>
          {uploadError && (
            <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {uploadError}
            </p>
          )}
          {report && <ReportView report={report} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Uploaded files</CardTitle>
          <CardDescription>
            {files.length === 0
              ? "No 835 uploaded yet."
              : "Newest first. Open a file to see each line and the bill it posted to."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">
              {error}
            </p>
          )}
          {loading && <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>}
          {files.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-semibold px-4 py-2.5">Uploaded</th>
                    <th className="text-left font-semibold px-4 py-2.5">File</th>
                    <th className="text-left font-semibold px-4 py-2.5">Payer · trace</th>
                    <th className="text-right font-semibold px-4 py-2.5">Claims</th>
                    <th className="text-left font-semibold px-4 py-2.5">Posted</th>
                    <th className="text-right font-semibold px-4 py-2.5">File total</th>
                    <th className="font-semibold px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {files.map((f) => (
                    <Fragment key={f.id}>
                      <tr className="align-top hover:bg-slate-50">
                        <td className="px-4 py-2 tabular text-slate-700">
                          {/* The viewer's date: slicing the UTC stamp filed an upload
                              after local midnight under the day before. */}
                          {localDateKey(new Date(f.uploadedAt))}
                          {f.uploadedBy && <div className="text-xs text-slate-500">{f.uploadedBy}</div>}
                        </td>
                        <td className="px-4 py-2 text-slate-700 break-all">{f.filename}</td>
                        <td className="px-4 py-2 text-slate-600">
                          {f.payerName ?? "—"}
                          {f.traceNumber && <div className="font-mono text-xs">{f.traceNumber}</div>}
                        </td>
                        <td className="px-4 py-2 text-right tabular">{f.claimCount}</td>
                        <td className="px-4 py-2 text-xs text-slate-600">
                          {[
                            f.counts.paid > 0 && `${f.counts.paid} paid`,
                            f.counts.partiallyPaid > 0 && `${f.counts.partiallyPaid} partially paid`,
                            f.counts.denied > 0 && `${f.counts.denied} denied`,
                            f.counts.unmatched > 0 && `${f.counts.unmatched} unmatched`,
                            f.counts.needsReview > 0 && `${f.counts.needsReview} need review`,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </td>
                        <td className="px-4 py-2 text-right tabular">{money(f.totalPaidCents)}</td>
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void toggle(f.id)}
                            aria-expanded={openId === f.id}
                            className="text-xs text-[var(--color-brand-700)] hover:underline"
                          >
                            {openId === f.id ? "Hide lines" : "Lines →"}
                          </button>
                        </td>
                      </tr>
                      {openId === f.id && (
                        <tr>
                          <td colSpan={7} className="bg-slate-50/60 px-4 py-3">
                            {lines[f.id] ? (
                              <LinesTable lines={lines[f.id]!} />
                            ) : (
                              <p className="text-sm text-slate-500">Loading…</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

function ReportView({ report }: { report: Report }) {
  const c = report.counts;
  return (
    <div className="mt-4 space-y-3" role="status">
      {report.alreadyUploaded && (
        <p className="text-sm text-slate-600">
          This file was uploaded before. Claims that posted then were skipped; only what had not
          posted was tried again.
        </p>
      )}
      <p className="text-sm font-medium text-slate-900">{summaryLine(c)}</p>

      {report.unmatched.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
            Unmatched — no bill carries these Claim refs
          </p>
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="text-left font-semibold py-1">Claim (CLP01)</th>
                <th className="text-left font-semibold py-1">DOS</th>
                <th className="text-right font-semibold py-1">Billed</th>
                <th className="text-right font-semibold py-1">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.unmatched.map((u, i) => (
                <tr key={`${u.claimId}-${i}`}>
                  <td className="py-1.5 font-mono text-xs">{u.claimId || "—"}</td>
                  <td className="py-1.5 tabular">{u.dos ?? "—"}</td>
                  <td className="py-1.5 text-right tabular">{money(u.billedCents)}</td>
                  <td className="py-1.5 text-right tabular">{money(u.paidCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.needsReview.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
            Needs review — not posted
          </p>
          <ul className="space-y-1 text-sm">
            {report.needsReview.map((n, i) => (
              <li key={`${n.claimId}-${i}`}>
                <span className="font-mono text-xs">{n.claimId || "—"}</span>{" "}
                <span className="text-slate-600">— {n.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.errors.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-red-700 mb-1">Could not post</p>
          <ul className="space-y-1 text-sm">
            {report.errors.map((e, i) => (
              <li key={`${e.claimId}-${i}`}>
                <span className="font-mono text-xs">{e.claimId || "—"}</span>{" "}
                <span className="text-red-700">— {e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LinesTable({ lines }: { lines: LineRow[] }) {
  if (lines.length === 0) return <p className="text-sm text-slate-500">This file has no lines on record.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-slate-500">
        <tr>
          <th className="text-left font-semibold py-1 pr-3">Claim</th>
          <th className="text-left font-semibold py-1 pr-3">Code</th>
          <th className="text-left font-semibold py-1 pr-3">DOS</th>
          <th className="text-right font-semibold py-1 pr-3">Billed</th>
          <th className="text-right font-semibold py-1 pr-3">Paid</th>
          <th className="text-left font-semibold py-1 pr-3">Reason</th>
          <th className="text-left font-semibold py-1 pr-3">Posting</th>
          <th className="text-left font-semibold py-1">Bill</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {lines.map((l) => (
          <tr key={`${l.claimSeq}-${l.lineSeq}`} className="align-top">
            <td className="py-1.5 pr-3 font-mono text-xs">{l.claimId ?? "—"}</td>
            <td className="py-1.5 pr-3 font-mono text-xs">
              {l.serviceCodes.join(", ") || "—"}
              {l.modifiers.length > 0 && <span className="text-slate-500">-{l.modifiers.join("-")}</span>}
            </td>
            <td className="py-1.5 pr-3 tabular">{l.dateOfService ?? "—"}</td>
            <td className="py-1.5 pr-3 text-right tabular">{money(l.billedCents)}</td>
            <td className="py-1.5 pr-3 text-right tabular">{money(l.paidCents)}</td>
            <td className="py-1.5 pr-3 font-mono text-xs">
              {[
                l.groupCode && l.carcCodes.length > 0 ? `${l.groupCode}-${l.carcCodes.join(", ")}` : l.carcCodes.join(", "),
                l.rarcCodes.join(", "),
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </td>
            <td className="py-1.5 pr-3">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${POSTING[l.posting].cls}`}
              >
                {POSTING[l.posting].label}
              </span>
              {l.postingNote && l.lineSeq <= 1 && (
                <div className="mt-0.5 text-xs text-slate-500 max-w-xs">{l.postingNote}</div>
              )}
            </td>
            <td className="py-1.5">
              {l.visitId ? (
                <Link
                  href={`/visits/${l.visitId}/superbill`}
                  className="text-xs text-[var(--color-brand-700)] hover:underline"
                >
                  <span className="font-mono">{l.claimRef}</span> →
                </Link>
              ) : (
                <span className="text-xs text-slate-500">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
