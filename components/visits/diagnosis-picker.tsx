/**
 * The diagnoses a visit addressed, in ICD-10. The first code is primary.
 *
 * Audit R13, rated blocking: the document screen had no diagnosis input, so
 * every bill silently inherited the patient's intake diagnosis — or went out
 * with none, and a claim with no ICD-10 is rejected before a payer reviews it.
 * Mark [10:12]: "take the note and... take the superbill and compare them and
 * make sure that they match." A diagnosis copied from intake months ago is not
 * a record of what this visit addressed.
 *
 * The intake diagnosis is offered as a one-click choice, never applied
 * silently: the clinician decides whether it is still what they treated.
 */
"use client";

import { useEffect, useState } from "react";

interface Match {
  code: string;
  description: string;
}

export function DiagnosisPicker({
  value,
  onChange,
  readOnly,
  intakeDiagnosis,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  readOnly?: boolean;
  /** The patient's primary diagnosis from intake — offered, never applied. */
  intakeDiagnosis?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Debounced search. State is only set from the timer callback, never
  // synchronously in the effect body.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let abandoned = false;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/billing/icd10?query=${encodeURIComponent(q)}&limit=8`);
        const d = await r.json();
        if (abandoned) return;
        if (!d.success) {
          setError(d.error ?? "Could not search diagnoses.");
          return;
        }
        const rows = (d.data?.rows ?? []) as Match[];
        setError(null);
        setMatches(rows);
        setDescriptions((m) => ({
          ...m,
          ...Object.fromEntries(rows.map((x) => [x.code, x.description])),
        }));
      } catch {
        if (!abandoned) setError("Network error searching diagnoses.");
      }
    }, 250);
    return () => {
      abandoned = true;
      clearTimeout(timer);
    };
  }, [query]);

  const results =
    query.trim().length >= 2 ? matches.filter((m) => !value.includes(m.code)) : [];

  const add = (code: string) => {
    if (!value.includes(code)) onChange([...value, code]);
    setQuery("");
    setMatches([]);
  };
  const remove = (code: string) => onChange(value.filter((c) => c !== code));
  const makePrimary = (code: string) => onChange([code, ...value.filter((c) => c !== code)]);

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="text-xs text-amber-800">
          {/* Not "the bill is built from these": this picker renders on a "Not
              billed" visit too, which drafts no bill — the card above says so,
              and so does the sign-off refusal. The clinical reason is the one
              that is true on every visit type. */}
          Required to sign: a signed encounter has to say what it was for.
        </p>
      ) : (
        <ul className="space-y-1.5" aria-label="Diagnoses on this visit">
          {value.map((code, i) => (
            <li key={code} className="flex items-start justify-between gap-2 text-sm">
              <span>
                <span className="font-mono text-xs text-slate-900">{code}</span>
                {i === 0 && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-500">
                    primary
                  </span>
                )}
                {descriptions[code] && (
                  <span className="block text-xs text-slate-600">{descriptions[code]}</span>
                )}
              </span>
              {!readOnly && (
                <span className="flex shrink-0 gap-2">
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() => makePrimary(code)}
                      aria-label={`Make ${code} the primary diagnosis`}
                      className="text-xs text-slate-500 hover:text-slate-800"
                    >
                      Make primary
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(code)}
                    aria-label={`Remove ${code}`}
                    className="text-xs text-slate-500 hover:text-red-700"
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <>
          {value.length === 0 && intakeDiagnosis && (
            <button
              type="button"
              onClick={() => add(intakeDiagnosis)}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-medium ring-1 ring-inset ring-slate-300 hover:ring-slate-400"
            >
              Use intake diagnosis {intakeDiagnosis}
            </button>
          )}
          <div>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search ICD-10 by code or description"
              aria-label="Search diagnoses (ICD-10)"
              className="w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
            />
            {error && (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {error}
              </p>
            )}
            {results.length > 0 && (
              <ul
                aria-label="Diagnosis matches"
                className="mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white"
              >
                {results.map((m) => (
                  <li key={m.code}>
                    <button
                      type="button"
                      onClick={() => add(m.code)}
                      className="w-full px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="font-mono text-xs text-slate-900">{m.code}</span>{" "}
                      <span className="text-slate-600">{m.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
