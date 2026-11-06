/**
 * Documents kept on a referral or a chart (0112; Mark Q11j default: referral
 * paperwork kept on the patient as attachments).
 *
 * The same card on both: on the referral it is the paperwork that came with
 * it; on the chart, everything filed for the patient, the referral's included.
 * A document filed in error is removed with a reason, which empties the file
 * and keeps the line.
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { Select, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABEL,
  DOCUMENT_MAX_BYTES,
  formatBytes,
  type DocumentKind,
  type DocumentView,
} from "@/lib/features/patient-documents/patient-document.types";
import { usePracticeTime } from "@/lib/features/schedule/use-practice-zone";

export function DocumentsCard({
  url,
  canEdit,
  title,
  description,
  emptyText,
  showOrigin,
  className,
}: {
  /** GET lists, POST uploads. */
  url: string;
  canEdit: boolean;
  title: string;
  description: string;
  emptyText: string;
  /** Mark the documents that came with the referral (on the chart). */
  showOrigin?: boolean;
  className?: string;
}) {
  const [docs, setDocs] = useState<DocumentView[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Filed and removed on the practice's clock.
  const when = usePracticeTime();
  // Bumped after a change, to read the list again.
  const [version, setVersion] = useState(0);
  const [kind, setKind] = useState<DocumentKind | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [removing, setRemoving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let abandoned = false;
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (d.success) {
          setDocs(d.data?.documents ?? []);
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => {
        if (!abandoned) setFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [url, version]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose the file.");
    if (!kind) return setError("Say what the document is.");
    if (file.size > DOCUMENT_MAX_BYTES) return setError("The file is over 10 MB.");
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", kind);
      const r = await fetch(url, { method: "POST", body });
      const d = await r.json().catch(() => null);
      if (!d?.success) {
        setError(d?.error ?? (r.status === 413 ? "The file is too large." : "Not uploaded."));
        return;
      }
      setFile(null);
      setKind("");
      if (fileInput.current) fileInput.current.value = "";
      setVersion((v) => v + 1);
    } catch {
      setError("Network error — not uploaded.");
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    if (!reason.trim()) return setError("Say why it is being removed.");
    setRemoving(true);
    setError(null);
    try {
      const r = await fetch(`/api/patient-documents/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Not removed.");
        return;
      }
      setRemovingId(null);
      setReason("");
      setVersion((v) => v + 1);
    } catch {
      setError("Network error — not removed.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {failed ? (
          <p className="text-slate-500">The documents could not be loaded.</p>
        ) : docs === null ? (
          <p className="text-slate-500">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="text-slate-500">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label={title}>
            {docs.map((d) => (
              <li key={d.id} className="py-2 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">
                    {DOCUMENT_KIND_LABEL[d.kind]}
                  </span>
                  {d.removedAt ? (
                    <span className="text-slate-500 line-through break-all">{d.fileName}</span>
                  ) : (
                    <a
                      href={`/api/patient-documents/${d.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-brand-700)] hover:underline break-all"
                    >
                      {d.fileName}
                    </a>
                  )}
                  <span className="text-xs text-slate-500 tabular">{formatBytes(d.sizeBytes)}</span>
                  {showOrigin && d.fromReferral && (
                    <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-800">from the referral</span>
                  )}
                  {canEdit && !d.removedAt && removingId !== d.id && (
                    <button
                      type="button"
                      className="ml-auto text-xs text-slate-500 hover:text-red-700"
                      onClick={() => {
                        setRemovingId(d.id);
                        setReason("");
                        setError(null);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {d.uploadedByName ?? "Someone"}, {when(d.uploadedAt)}
                </p>
                {d.removedAt && (
                  <p className="mt-0.5 text-xs text-slate-600">
                    Removed by {d.removedByName ?? "someone"}, {when(d.removedAt)}: {d.removedReason}
                  </p>
                )}
                {removingId === d.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Remove document">
                    <TextInput
                      aria-label="Why it is being removed"
                      placeholder="Why, e.g. filed on the wrong patient"
                      value={reason}
                      maxLength={300}
                      onChange={(e) => setReason(e.target.value)}
                      className="h-8 flex-1 min-w-48 text-sm"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setRemovingId(null)} disabled={removing}>
                      Cancel
                    </Button>
                    <Button type="button" variant="danger" size="sm" loading={removing} onClick={() => void remove(d.id)}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={upload} className="flex flex-wrap items-end gap-2 pt-1" aria-label="Add a document">
            <label className="flex-1 min-w-44">
              <span className="sr-only">File</span>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setError(null);
                }}
                className="block w-full text-sm text-slate-700 file:mr-2 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-sm"
              />
            </label>
            <Select
              aria-label="What it is"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as DocumentKind);
                setError(null);
              }}
              className="h-9 w-auto text-sm"
            >
              <option value="" disabled>
                What it is…
              </option>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DOCUMENT_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="secondary" size="sm" className="h-9" loading={uploading}>
              Upload
            </Button>
          </form>
        )}
        {canEdit && <p className="text-xs text-slate-500">PDF, JPEG or PNG, up to 10 MB.</p>}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
