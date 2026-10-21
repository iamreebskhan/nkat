/**
 * The note as it will read when finished.
 *
 * Mark [06:43]: "it'll give you some structure to understand how it needs to
 * look on the finished product." Editing a note section by section never shows
 * you the thing an auditor will actually read, and the only rendered form that
 * existed was the PDF packet — gated on a billing permission and refused on
 * unsigned visits, so invisible at the one moment it is useful.
 *
 * The HTML comes from renderSectionHtml on the server, the same renderer the
 * audit packet uses, so what a clinician previews and what an auditor receives
 * cannot drift. That renderer escapes every piece of text and emits a fixed
 * tag allowlist with no href, src or style — which is what makes it safe to
 * inject here.
 */
"use client";

import { useEffect, useState } from "react";

export function NotePreview({ visitId }: { visitId: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      const r = await fetch(`/api/visits/${visitId}/note-preview`).catch(() => null);
      if (!r || abandoned) return;
      const d = await r.json().catch(() => null);
      if (!d || abandoned) return;
      if (!d.success) {
        setError(d.error ?? "Could not render the note.");
        return;
      }
      setHtml(d.data.html as string);
    })();
    return () => {
      abandoned = true;
    };
  }, [visitId]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }
  if (html === null) return <p className="text-sm text-slate-500">Rendering the note…</p>;

  return (
    <div
      data-testid="note-preview"
      className="note-preview rounded-md border border-slate-200 bg-white px-6 py-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
