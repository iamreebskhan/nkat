/**
 * Icd10Picker — autocomplete ICD-10 diagnosis picker (Phase C.1).
 *
 * Replaces the free-text comma-separated ICD-10 input on the superbill.
 * Type ≥2 chars → debounced search of the icd10 reference table; click a
 * result to add it. Selected codes show as removable chips. Codes are
 * validated against the reference (free-typed unknown codes are still
 * allowed via Enter, mirroring clinical override behavior).
 */
"use client";

import { Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface Match {
  code: string;
  description: string;
  billable: boolean;
  chapter: string | null;
}

interface Props {
  selected: string[];
  onChange: (codes: string[]) => void;
  disabled?: boolean;
}

export function Icd10Picker({ selected, onChange, disabled }: Props) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setMatches([]);
      return;
    }
    let abandoned = false;
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/billing/icd10?query=${encodeURIComponent(query.trim())}`, {
        signal: ctrl.signal,
      })
        .then((r) => r.json())
        .then((d) => {
          if (!abandoned && d.success) setMatches(d.data.rows ?? []);
        })
        .catch(() => {})
        .finally(() => {
          if (!abandoned) setLoading(false);
        });
    }, 250);
    return () => {
      abandoned = true;
      ctrl.abort();
      clearTimeout(t);
    };
  }, [query]);

  function add(code: string) {
    const c = code.trim().toUpperCase();
    if (!c || selected.includes(c)) return;
    onChange([...selected, c]);
    setQuery("");
    setMatches([]);
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Selected diagnoses">
          {selected.map((code) => (
            <span
              key={code}
              className="inline-flex items-center gap-1 rounded-md bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-600/20 px-2 py-1 text-xs font-mono tabular"
            >
              {code}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((c) => c !== code))}
                  aria-label={`Remove ${code}`}
                  className="hover:bg-white/40 rounded p-0.5"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // Add exact-typed code (uppercase, ICD-10 shape) as override.
              if (/^[A-Z]\d/i.test(query.trim())) add(query);
            }
          }}
          placeholder="Search ICD-10 (e.g. Z51.5, neoplasm)…"
          aria-label="Search ICD-10 diagnoses"
          className="w-full rounded-md border border-slate-300 pl-9 pr-3 py-2 text-sm tabular focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:bg-slate-50"
        />
      </div>
      {query.trim().length >= 2 && (
        <ul className="max-h-56 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100">
          {loading && <li className="px-3 py-2 text-xs text-slate-400">Searching…</li>}
          {!loading && matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-slate-400">
              No match. Press Enter to add &ldquo;{query.trim().toUpperCase()}&rdquo; anyway.
            </li>
          )}
          {matches.map((m) => (
            <li key={m.code}>
              <button
                type="button"
                onClick={() => add(m.code)}
                className={cn(
                  "w-full text-left px-3 py-2 hover:bg-slate-50 flex items-start gap-2",
                  selected.includes(m.code) && "bg-sky-50/40",
                )}
              >
                <Plus className="h-3.5 w-3.5 text-slate-400 mt-0.5" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono tabular text-sm font-medium">{m.code}</span>
                    {!m.billable && (
                      <span className="text-[10px] text-amber-700">non-billable header</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 truncate">{m.description}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
