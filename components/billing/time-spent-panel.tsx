/**
 * TimeSpentPanel — Phase C nurse-friendly minute capture + code suggestions.
 *
 * Mark's 2026-05-22 answer: nurses TYPE the minutes at end of visit
 * (option a). The slider here is exact-typed + drag; the suggestion
 * column on the right tells the nurse which CPT applies to the
 * current minute bracket so they don't have to memorize thresholds.
 *
 * Brackets cover the established-patient home-visit set Mark used in the
 * call (99347/99348/99349/99350). The picker is still the authoritative
 * source of "is this code covered by THIS payer" — this panel only
 * suggests, never picks.
 *
 * Thresholds are the minimum total times for the 2023+ home and residence
 * E/M codes: 99347 20 min, 99348 30, 99349 40, 99350 60 — the same
 * typical_minutes the code table and the document page's bands use. The
 * brackets used to start each code ten minutes early (0–19 → 99347,
 * 20–39 → 99348), so the panel suggested, and added in one click, a code
 * whose time the visit had not met. Below 20 minutes no time-based code
 * applies, and the panel now says so.
 *
 * No descriptor text: CPT descriptors are AMA-licensed (audit R21), and
 * these hand-written labels showed on unlicensed deployments beside a
 * picker saying the descriptor was withheld. The code and its minute range
 * are what the nurse needs.
 *
 * The bill page passes the ladder for the visit's own band and the visit's
 * ACP minutes. Before, every visit got the established ladder, so a new
 * patient's bill was offered an established code, and the ACP minutes were
 * counted as E/M time: 45 minutes with 20 of ACP offered 99349 where the 25
 * E/M minutes are 99341 — and "Use this code" put it on the bill beside the
 * visit's own code.
 */
"use client";

import { Clock } from "lucide-react";

import { acpBilledMinutes } from "@/lib/features/visits/cpt-suggester";

export interface ThresholdBracket {
  /** Inclusive minimum minutes. */
  min: number;
  /** Inclusive maximum minutes (Infinity for the top bracket). */
  max: number;
  /** CPT to suggest in this bracket. */
  code: string;
}

export const HOME_VISIT_ESTABLISHED: readonly ThresholdBracket[] = [
  { min: 20, max: 29, code: "99347" },
  { min: 30, max: 39, code: "99348" },
  { min: 40, max: 59, code: "99349" },
  { min: 60, max: Number.POSITIVE_INFINITY, code: "99350" },
];

/**
 * The code whose time threshold these minutes meet, or null below the first.
 * `brackets` is the ladder for the visit's band, the established one when
 * none is given.
 */
export function suggestedHomeVisitCode(
  minutes: number,
  brackets: readonly ThresholdBracket[] = HOME_VISIT_ESTABLISHED,
): ThresholdBracket | null {
  for (const b of brackets) {
    if (minutes >= b.min && minutes <= b.max) return b;
  }
  return null;
}

const range = (b: ThresholdBracket) => `${b.min}${Number.isFinite(b.max) ? `–${b.max}` : "+"} min`;

interface Props {
  minutes: number;
  onChange: (next: number) => void;
  /** Disabled when the bill is past 'draft'. */
  disabled?: boolean;
  /** When set, calling "Use suggested code" passes the bracket code up. */
  onUseSuggestion?: (code: string) => void;
  /** Codes already on the bill — used to indicate the suggestion is already present. */
  selectedCodes?: string[];
  /**
   * The visit's documented ACP minutes. Those that bill as 99497/99498 are
   * not E/M time, so they are taken out before a code is chosen, exactly as
   * the document page's suggester takes them out.
   */
  acpMinutes?: number;
  /** The ladder for the visit's band; empty when it has no home-visit ladder. */
  brackets?: readonly ThresholdBracket[];
}

export function TimeSpentPanel({
  minutes,
  onChange,
  disabled,
  onUseSuggestion,
  selectedCodes = [],
  acpMinutes = 0,
  brackets = HOME_VISIT_ESTABLISHED,
}: Props) {
  const acpBilled = acpBilledMinutes(acpMinutes);
  const emMinutes = Math.max(0, minutes - acpBilled);
  const bracket = minutes >= acpBilled ? suggestedHomeVisitCode(emMinutes, brackets) : null;
  const already = bracket ? selectedCodes.includes(bracket.code) : false;
  // Said wherever a code is chosen on less than the minutes typed.
  const countedOn =
    acpBilled > 0
      ? ` Counted on ${emMinutes} of the ${minutes} minutes: the ${acpBilled} ACP minutes bill as 99497/99498.`
      : "";
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
        {brackets.length === 0 ? (
          <p className="text-slate-500">
            No time-based home visit code applies to this visit&rsquo;s type.
          </p>
        ) : minutes <= 0 ? (
          <p className="text-slate-500">Enter visit minutes to see code suggestion.</p>
        ) : minutes < acpBilled ? (
          <p className="text-slate-500">
            Fewer minutes than the visit&rsquo;s {acpBilled} ACP minutes, which bill as
            99497/99498: no E/M time is left to code.
          </p>
        ) : bracket ? (
          <p className="text-slate-700">
            Suggested code:{" "}
            <span className="font-mono tabular">{bracket.code}</span>{" "}
            <span className="text-slate-500">({range(bracket)})</span>
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
            {countedOn && <span className="block text-slate-500">{countedOn.trim()}</span>}
          </p>
        ) : (
          <p className="text-slate-500">
            Under {brackets[0]!.min} minutes{acpBilled > 0 ? " of E/M time" : ""}: no time-based
            home visit code applies.
            {countedOn && <span className="block">{countedOn.trim()}</span>}
          </p>
        )}
        {brackets.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">
            {brackets.map((b) => (
              <li key={b.code}>
                {range(b)} → <span className="font-mono">{b.code}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
