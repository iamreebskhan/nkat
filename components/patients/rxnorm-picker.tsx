/**
 * Coding a medication or a drug allergy in RxNorm (0128). The search runs when
 * asked, on what was typed in the field above it, and only those words go to
 * NLM. Choosing a match is optional: what was typed saves as it is, and can be
 * coded later. Changing the words afterwards takes the code off, so a code never
 * describes something else.
 */
"use client";

import { useState } from "react";

import type { RxnormConcept } from "@/lib/features/clinical/rxnorm.service";

export function RxnormPicker({
  term,
  cui,
  use,
  onPick,
  onClear,
}: {
  term: string;
  cui: string;
  use: "medication" | "allergy";
  onPick: (c: RxnormConcept) => void;
  onClear: () => void;
}) {
  const [rows, setRows] = useState<RxnormConcept[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typed = term.trim();

  async function search() {
    setBusy(true);
    setNote(null);
    setRows(null);
    try {
      const d = await fetch(`/api/terminology/rxnorm?q=${encodeURIComponent(typed)}&use=${use}`).then((r) => r.json());
      if (!d.success) return setNote(d.error ?? "RxNorm could not be searched. It will save as typed.");
      if (d.data.unavailable) return setNote("RxNorm could not be reached. It will save as typed, and can be coded later.");
      if (d.data.rows.length === 0) return setNote("No match in RxNorm. It will save as typed.");
      setRows(d.data.rows);
    } catch {
      setNote("RxNorm could not be reached. It will save as typed, and can be coded later.");
    } finally {
      setBusy(false);
    }
  }

  if (cui) {
    return (
      <p className="mt-1 text-xs text-slate-600">
        RxNorm {cui}{" "}
        <button type="button" className="text-[var(--color-brand-700)] hover:underline" onClick={onClear}>
          Take the code off
        </button>
      </p>
    );
  }

  return (
    <div className="mt-1 text-xs">
      <button type="button" disabled={typed.length < 3 || busy} className="text-[var(--color-brand-700)] hover:underline disabled:text-slate-400 disabled:no-underline" onClick={() => void search()}>
        {busy ? "Searching RxNorm…" : "Find in RxNorm"}
      </button>
      {note && (
        <p role="status" className="mt-1 text-slate-600">
          {note}
        </p>
      )}
      {rows && (
        <ul role="listbox" aria-label="RxNorm matches" className="mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white">
          {rows.map((r) => (
            <li key={r.rxcui}>
              <button
                type="button"
                className="block w-full px-2 py-1 text-left hover:bg-slate-50"
                onClick={() => {
                  setRows(null);
                  onPick(r);
                }}
              >
                {r.name} <span className="text-slate-400">({r.rxcui})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
