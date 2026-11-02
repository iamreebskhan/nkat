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
 *
 * A code the search does not return can still be added, typed in full: the
 * picker took ONLY search results, and while the reference table held 22
 * curated codes a bereavement call on production could not record Z63.4 at
 * all. The table now holds the full release, so this is for a code newer
 * than it; the code must be shaped like ICD-10-CM, and its chip says it was
 * not found so the clinician checks it before signing.
 */
"use client";

import { useEffect, useState } from "react";

import { normalizeIcd10 } from "@/lib/features/billing/icd10-format";

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
  /** The query `matches` answers, so "not found" is only said once the search is back. */
  const [searched, setSearched] = useState("");
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  /** Codes added by hand that the search did not know. */
  const [unlisted, setUnlisted] = useState<string[]>([]);
  /** Codes already looked up for their wording, found or not. */
  const [looked, setLooked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Saved codes arrive as bare codes: the wording above came only from this
  // session's searches, so a reloaded visit showed codes alone, and a code
  // added by hand that the list does not hold lost its warning — on the next
  // visit to the page it looked like any other, right up to signing. Each one
  // is looked up once. A billable ICD-10-CM code is a leaf, so searching its
  // own text returns it exactly when the list holds it.
  useEffect(() => {
    const pending = value.filter(
      (c) => !descriptions[c] && !unlisted.includes(c) && !looked.includes(c),
    );
    if (pending.length === 0) return;
    let abandoned = false;
    const timer = setTimeout(async () => {
      const found: Record<string, string> = {};
      const missing: string[] = [];
      await Promise.all(
        pending.map(async (code) => {
          try {
            const r = await fetch(`/api/billing/icd10?query=${encodeURIComponent(code)}&limit=8`);
            const d = await r.json();
            if (!d.success) return;
            const hit = ((d.data?.rows ?? []) as Match[]).find((m) => m.code === code);
            if (hit) found[code] = hit.description;
            else missing.push(code);
          } catch {
            /* the code still shows; only its wording is missing */
          }
        }),
      );
      if (abandoned) return;
      setLooked((l) => [...l, ...pending]);
      setDescriptions((m) => ({ ...m, ...found }));
      setUnlisted((u) => [...u, ...missing.filter((c) => !u.includes(c))]);
    }, 0);
    return () => {
      abandoned = true;
      clearTimeout(timer);
    };
  }, [value, descriptions, unlisted, looked]);

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
        setSearched(q);
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

  // A code typed in full that the search, now back for this query, did not
  // return: offered as an explicit "add anyway", never added silently.
  const typed = normalizeIcd10(query);
  const listed = typed ? matches.find((m) => m.code === typed) : undefined;
  const offerUnlisted =
    typed !== null && !listed && !value.includes(typed) && searched === query.trim();

  const add = (code: string) => {
    if (!value.includes(code)) onChange([...value, code]);
    setQuery("");
    setMatches([]);
    setSearched("");
  };
  const addUnlisted = (code: string) => {
    setUnlisted((u) => (u.includes(code) ? u : [...u, code]));
    add(code);
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
                {unlisted.includes(code) && (
                  <span className="block text-xs text-amber-800">
                    {readOnly
                      ? "Not in the ICD-10-CM list Pallio holds."
                      : "Not in the ICD-10-CM list Pallio holds — check the code before signing."}
                  </span>
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
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // Enter takes the code typed: the listed one when the search
                // has it, else the unlisted one it offers below.
                e.preventDefault();
                if (listed && !value.includes(listed.code)) add(listed.code);
                else if (offerUnlisted && typed) addUnlisted(typed);
              }}
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
            {offerUnlisted && typed && (
              <button
                type="button"
                onClick={() => addUnlisted(typed)}
                className="mt-1 w-full rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-left text-xs text-amber-900 hover:bg-amber-100"
              >
                Add <span className="font-mono">{typed}</span> anyway — it is not in the ICD-10-CM list
                Pallio holds, so check the code before signing.
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
