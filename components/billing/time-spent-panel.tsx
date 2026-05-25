/**
 * TimeSpentPanel — Phase C nurse-friendly minute capture + code suggestions.
 *
 * Mark's 2026-05-22 answer: nurses TYPE the minutes at end of visit
 * (option a). The slider here is exact-typed + drag; the suggestion
 * column on the right tells the nurse which CPT applies to the
 * current minute bracket so they don't have to memorize thresholds.
 *
 * Brackets cover the home-visit set Mark used in the call
 * (99347/99348/99349/99350 established-patient + new-patient analogs
 * 99341/99342/99343/99344/99345). Threshold rules from CMS PFS
 * descriptors; if the underlying threshold changes, edit it here.
 * The picker is still the authoritative source of "is this code
 * covered by THIS payer" — this panel only suggests, never picks.
 */
"use client";

import { Clock } from "lucide-react";

interface ThresholdBracket {
  /** Inclusive minimum minutes. */
  min: number;
  /** Inclusive maximum minutes (Infinity for the top bracket). */
  max: number;
  /** CPT to suggest in this bracket. */
  code: string;
  /** Short label shown in the suggestion column. */
  label: string;
}

const HOME_VISIT_ESTABLISHED: ThresholdBracket[] = [
  { min: 0, max: 19, code: "99347", label: "Home visit, est., 15–29 min" },
  { min: 20, max: 39, code: "99348", label: "Home visit, est., 30–39 min" },
  { min: 40, max: 59, code: "99349", label: "Home visit, est., 40–59 min" },
  { min: 60, max: Number.POSITIVE_INFINITY, code: "99350", label: "Home visit, est., 60+ min" },
];

function bracketFor(minutes: number): ThresholdBracket | null {
  for (const b of HOME_VISIT_ESTABLISHED) {
    if (minutes >= b.min && minutes <= b.max) return b;
  }
  return null;
}

interface Props {
  minutes: number;
  onChange: (next: number) => void;
  /** Disabled when the bill is past 'draft'. */
  disabled?: boolean;
  /** When set, calling "Use suggested code" passes the bracket code up. */
  onUseSuggestion?: (code: string) => void;
  /** Codes already on the bill — used to indicate the suggestion is already present. */
  selectedCodes?: string[];
}

export function TimeSpentPanel({
  minutes,
  onChange,
  disabled,
  onUseSuggestion,
  selectedCodes = [],
}: Props) {
  const bracket = bracketFor(minutes);
  const already = bracket ? selectedCodes.includes(bracket.code) : false;
  return (
    <div className="rounded-md border border-slate-200 p-4 bg-slate-50/30">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <Clock className="h-4 w-4" aria-hidden /> Time spent
      </div>
      <div className="mt-3 flex items-center gap-3">
        <input
          type="number"
          min={0}
          max={300}
          value={minutes}
          onChange={(e) => onChange(parseInt(e.target.value || "0", 10))}
          disabled={disabled}
          aria-label="Minutes spent on visit"
          className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm tabular text-right focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:bg-slate-50"
        />
        <span className="text-xs text-slate-500">min</span>
        <input
          type="range"
          min={0}
          max={120}
          value={minutes}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          disabled={disabled}
          className="flex-1 accent-emerald-600"
          aria-label="Adjust minutes"
        />
      </div>
      <div className="mt-3 text-xs">
        {bracket ? (
          <p className="text-slate-700">
            Suggested code:{" "}
            <span className="font-mono tabular">{bracket.code}</span> —{" "}
            <span className="text-slate-500">{bracket.label}</span>
            {already ? (
              <span className="ml-2 text-emerald-700">· already added ✓</span>
            ) : (
              onUseSuggestion && (
                <button
                  type="button"
                  onClick={() => onUseSuggestion(bracket.code)}
                  className="ml-2 text-emerald-700 hover:underline"
                  disabled={disabled}
                >
                  Use this code →
                </button>
              )
            )}
          </p>
        ) : (
          <p className="text-slate-500">Enter visit minutes to see code suggestion.</p>
        )}
        <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">
          {HOME_VISIT_ESTABLISHED.map((b) => (
            <li key={b.code}>
              {b.min}–{Number.isFinite(b.max) ? b.max : "∞"} min →{" "}
              <span className="font-mono">{b.code}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
