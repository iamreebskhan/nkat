/**
 * CodeUnitsEditor — how many units of each per-increment add-on the bill
 * carries (0106).
 *
 * The suggester counts G0318 and 99417 per 15 minutes and 99498 per 30, and
 * the count now travels with the visit to the bill. This is where a biller
 * corrects it. Only those three codes get an input: a home E/M is reported
 * once per date of service and 99497 once per visit, so offering 99350 × 2
 * would offer something the server refuses.
 *
 * It shows normalizeUnits(codes, units), never the raw map, so a key left over
 * from a code that has since been removed never shows, and one that comes
 * back starts at one unit. onChange gets the whole normalized map; a count of
 * one is no key at all. The G0318 cap warning is inline, so it appears as the
 * number is typed rather than on the next load.
 */
"use client";

import { useState } from "react";

import {
  MAX_UNITS_PER_LINE,
  PER_INCREMENT_CODES,
  normalizeUnits,
  unitWarnings,
  unitsOf,
  type CodeUnits,
} from "@/lib/features/billing/code-units";

/** What one unit of each per-increment code stands for. */
const UNIT_OF: Record<string, string> = {
  G0318: "15 min each",
  "99417": "15 min each",
  "99498": "30 min each",
};

interface Props {
  /** The codes on the bill, including any pending picker edit. */
  codes: string[];
  /** Units per code as saved or edited; stale keys are ignored. */
  units: CodeUnits;
  onChange: (next: CodeUnits) => void;
  /** Read-only once the bill is past editing (submitted, paid, voided). */
  disabled?: boolean;
}

export function CodeUnitsEditor({ codes, units, onChange, disabled }: Props) {
  // What the biller is typing in each box until it is a count the bill takes
  // (a whole number 1–99). Cleared on blur, so the box shows the saved count.
  const [typing, setTyping] = useState<Record<string, string>>({});
  const current = normalizeUnits(codes, units);
  const editable = [...new Set(codes)].filter((c) => PER_INCREMENT_CODES.has(c));
  if (editable.length === 0) return null;
  const warnings = unitWarnings(codes, current);

  function typeUnits(code: string, text: string) {
    setTyping((t) => ({ ...t, [code]: text }));
    const n = Number(text);
    if (text.trim() === "" || !Number.isInteger(n) || n < 1 || n > MAX_UNITS_PER_LINE) return;
    onChange(normalizeUnits(codes, { ...current, [code]: n }));
  }

  return (
    <div className="mt-3 space-y-1.5">
      <div className="text-xs text-slate-500 font-medium">Units</div>
      <ul className="space-y-1">
        {editable.map((code) => (
          <li key={code} className="flex items-center gap-2 text-sm">
            <span className="w-14 font-mono tabular text-slate-700">{code}</span>
            <input
              type="number"
              min={1}
              max={MAX_UNITS_PER_LINE}
              step={1}
              value={typing[code] ?? String(unitsOf(current, code))}
              onChange={(e) => typeUnits(code, e.target.value)}
              onBlur={() =>
                setTyping((t) => {
                  const rest = { ...t };
                  delete rest[code];
                  return rest;
                })
              }
              disabled={disabled}
              aria-label={`${code} units`}
              className="w-16 rounded-md border border-slate-300 px-2 py-1 text-sm tabular text-right focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:bg-slate-50 disabled:text-slate-400"
            />
            <span className="text-xs text-slate-500">{UNIT_OF[code]}</span>
          </li>
        ))}
      </ul>
      {warnings.map((w) => (
        <p key={w} role="alert" className="text-xs text-amber-800">
          {w}
        </p>
      ))}
    </div>
  );
}
