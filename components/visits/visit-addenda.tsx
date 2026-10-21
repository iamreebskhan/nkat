/**
 * Addenda to a signed note (audit R15).
 *
 * The lock banner told clinicians to "record any change as an addendum", and
 * there was nowhere to write one. This lists the addenda already signed and,
 * for someone who may sign (visits.submit), takes a new one. A signed addendum
 * is part of the record: it cannot be edited or deleted.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface AddendumRow {
  id: string;
  body: string;
  authorName: string | null;
  authorCredential: string | null;
  signedAt: string;
}

export function VisitAddenda({ visitId, canSign }: { visitId: string; canSign: boolean }) {
  const [rows, setRows] = useState<AddendumRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      const d = await fetch(`/api/visits/${visitId}/addenda`)
        .then((r) => r.json())
        .catch(() => null);
      if (abandoned) return;
      if (d?.success) setRows(d.data.addenda ?? []);
      setLoaded(true);
    })();
    return () => {
      abandoned = true;
    };
  }, [visitId]);

  async function sign() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/visits/${visitId}/addenda`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not sign the addendum.");
        return;
      }
      setBody("");
      setRows((prev) => [...prev, d.data.addendum as AddendumRow]);
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Addenda</CardTitle>
        <CardDescription>
          Corrections to the signed note. Each is signed, printed after the note, and
          cannot be edited or deleted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!loaded ? (
          <p className="text-slate-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-slate-500">No addenda.</p>
        ) : (
          <ol className="space-y-3" aria-label="Signed addenda">
            {rows.map((a) => (
              <li key={a.id} className="rounded-md border border-slate-200 px-3 py-2">
                <p className="text-xs text-slate-500">
                  {a.authorName ?? "Unknown author"}
                  {a.authorCredential ? `, ${a.authorCredential}` : ""} ·{" "}
                  {new Date(a.signedAt).toLocaleString()}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-slate-800">{a.body}</p>
              </li>
            ))}
          </ol>
        )}

        {canSign && (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <label className="block">
              <span className="text-slate-700 font-medium">New addendum</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                maxLength={20_000}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                placeholder="What is being added or corrected, and why."
              />
            </label>
            {error && (
              <p role="alert" className="rounded bg-red-50 px-2 py-2 text-xs text-red-700">
                {error}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button onClick={sign} loading={saving} disabled={!body.trim()}>
                Sign addendum
              </Button>
              <span className="text-xs text-slate-500">
                Signed under your name and credential. It cannot be changed afterwards.
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
