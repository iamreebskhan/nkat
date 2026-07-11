/**
 * CodePicker — payer-scoped CPT/HCPCS picker (Phase A).
 *
 * Renders a searchable list of codes the patient's payer covers in
 * their state. Each option shows code · descriptor · provenance badge.
 * Selecting a code adds it to `selected`; selecting one already there
 * removes it. Nurse can flip "Show all codes" to widen the picker to
 * any active CPT/HCPCS — picks from outside the allow-list trigger
 * an override modal that requires a one-line reason (audit-logged
 * server-side via PATCH /api/superbills/[id] overrides[]).
 *
 * Source of data:
 *   GET /api/billing/allowed-codes?payerId&state&query
 *   "Show all" toggle adds includeDenied=true to surface not_covered /
 *   unknown rows so the nurse can pick one (override modal still fires).
 *
 * Empty state: if the payer has zero allowed codes (no rules ingested
 * yet for that payer/state), show a CTA to request analyst attestation
 * via POST /api/attestations/requests.
 */
"use client";

import { CheckCircle2, AlertTriangle, X, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CoverageBadge } from "@/components/ui/coverage-badge";
import { cn } from "@/lib/utils";

export interface AllowedCodeOption {
  code: string;
  descriptor: string;
  category: string | null;
  codeSystem: "CPT" | "HCPCS2";
  coverageStatus: "covered" | "varies";
  confidence: number;
  sourceKind: "crawler" | "analyst" | "ai" | "manual" | "unknown";
  modifierRequired: boolean;
  priorAuthRequired: boolean;
  hasFrequencyLimit: boolean;
}

interface Props {
  payerId: string | null;
  state: string | null;
  /** Currently selected codes on the draft. */
  selected: string[];
  /** Called when codes are added / removed. */
  onChange: (codes: string[]) => void;
  /** Called with {code, reason} when the nurse confirms an override. */
  onOverride?: (override: { code: string; reason: string }) => void;
  disabled?: boolean;
}

interface ApiResponse {
  success: boolean;
  data?: { rows: AllowedCodeOption[]; total: number };
  error?: string;
}

const SOURCE_KIND_LABEL: Record<AllowedCodeOption["sourceKind"], string> = {
  crawler: "Official policy",
  analyst: "Analyst-verified",
  ai: "AI draft (review)",
  manual: "Your org",
  unknown: "Unsourced",
};

export function CodePicker({
  payerId,
  state,
  selected,
  onChange,
  onOverride,
  disabled,
}: Props) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AllowedCodeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [override, setOverride] = useState<{ code: string; reason: string } | null>(
    null,
  );
  // Code typed into the empty-allow-list banner's attestation request. The
  // banner unmounts as soon as the MAIN query input gets text (the "no rules
  // on file" claim is only true for an empty query), so it needs its own field.
  const [attCode, setAttCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch the allow-list whenever payer / state / query changes.
  useEffect(() => {
    if (!payerId || !state) {
      setOptions([]);
      return;
    }
    let abandoned = false;
    const ctrl = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ payerId, state });
    if (query.trim().length > 0) params.set("query", query.trim());
    if (showAll) params.set("includeDenied", "true");
    fetch(`/api/billing/allowed-codes?${params.toString()}`, {
      signal: ctrl.signal,
    })
      .then((r) => r.json() as Promise<ApiResponse>)
      .then((data) => {
        if (abandoned) return;
        if (data.success && data.data) setOptions(data.data.rows);
        else setOptions([]);
      })
      .catch(() => {
        if (!abandoned) setOptions([]);
      })
      .finally(() => {
        if (!abandoned) setLoading(false);
      });
    return () => {
      abandoned = true;
      ctrl.abort();
    };
  }, [payerId, state, query, showAll]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggle(code: string) {
    if (selectedSet.has(code)) {
      onChange(selected.filter((c) => c !== code));
    } else {
      onChange([...selected, code]);
    }
  }

  function confirmOverride(code: string, reason: string) {
    onChange([...selected, code]);
    onOverride?.({ code, reason });
    setOverride(null);
  }

  // "Show all" + the nurse typed a code that isn't in the allow-list →
  // surface override modal on Enter / + click.
  function addRawCode() {
    const code = query.trim().toUpperCase();
    if (!code) return;
    if (!/^([A-Z]\d{4}|\d{4}[A-Z\d]|\d{5})$/.test(code)) return;
    if (selectedSet.has(code)) return;
    if (options.some((o) => o.code === code)) {
      // It IS on the allow-list (search match) — add directly.
      toggle(code);
    } else {
      setOverride({ code, reason: "" });
    }
    setQuery("");
    inputRef.current?.focus();
  }

  const noPayer = !payerId || !state;
  const empty = !loading && !noPayer && options.length === 0 && query.length === 0;

  return (
    <div className="space-y-3">
      {/* Currently selected — chip list */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Selected codes">
          {selected.map((code) => {
            const opt = options.find((o) => o.code === code);
            const isOverride = opt === undefined;
            return (
              <span
                key={code}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-mono tabular",
                  isOverride
                    ? "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-600/30"
                    : "bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-600/20",
                )}
              >
                {code}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => toggle(code)}
                    aria-label={`Remove ${code}`}
                    className="hover:bg-white/40 rounded p-0.5"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRawCode();
            }
          }}
          disabled={disabled || noPayer}
          placeholder={
            noPayer
              ? "Set the patient's payer + state first"
              : "Type code or descriptor (e.g. 99348, home visit)…"
          }
          aria-label="Search billable codes"
          className="w-full rounded-md border border-slate-300 pl-9 pr-3 py-2 text-sm tabular focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:bg-slate-50 disabled:text-slate-400"
        />
      </div>

      {/* Empty payer */}
      {noPayer && (
        <p className="text-xs text-slate-500">
          The picker needs the patient&rsquo;s primary payer + state. Set them on the patient record to unlock it.
        </p>
      )}

      {/* Empty allow-list */}
      {empty && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900">
          <p className="font-medium">No rules on file for this payer in this state.</p>
          <p className="mt-1">
            You can still bill — type any CPT/HCPCS above (we&rsquo;ll log it as an override).
            Or request an analyst attestation so the next billing agent gets the answer cached.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={attCode}
              onChange={(e) => setAttCode(e.target.value.toUpperCase())}
              placeholder="CPT/HCPCS e.g. G0318"
              maxLength={5}
              aria-label="Code to attest"
              className="w-36 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!/^[A-Z0-9]{4,5}$/.test(attCode.trim())}
              onClick={async () => {
                if (!payerId || !state) return;
                // The API requires a concrete 4-5 char code (and the analyst
                // needs one to verify) — the old "any" fallback 400'd silently
                // while still alerting success. Uses its own field because the
                // banner unmounts when the main query input has text.
                const code = attCode.trim().toUpperCase();
                const r = await fetch("/api/attestations/requests", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    payerId,
                    state,
                    cptCode: code,
                    attribute: "covered",
                    sourceQuery: "Empty allow-list at point of care",
                  }),
                });
                const d = await r.json().catch(() => null);
                if (d?.success) setAttCode("");
                alert(d?.success ? `Attestation request queued for ${code}.` : `Request failed: ${d?.error ?? `HTTP ${r.status}`}`);
              }}
            >
              Request analyst attestation
            </Button>
          </div>
        </div>
      )}

      {/* Suggestion list */}
      {!noPayer && options.length > 0 && (
        <ul
          role="listbox"
          aria-label="Payer-allowed codes"
          className="max-h-80 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100"
        >
          {options.map((o) => {
            const on = selectedSet.has(o.code);
            return (
              <li key={o.code}>
                <button
                  type="button"
                  onClick={() => toggle(o.code)}
                  className={cn(
                    "w-full text-left px-3 py-2 hover:bg-slate-50 flex items-start gap-3",
                    on && "bg-emerald-50/40",
                  )}
                  aria-pressed={on}
                >
                  <div className="mt-0.5">
                    {on ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <Plus className="h-4 w-4 text-slate-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono tabular text-sm font-medium">
                        {o.code}
                      </span>
                      <span className="text-sm text-slate-700 truncate">
                        {o.descriptor}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <CoverageBadge status={o.coverageStatus} size="sm" />
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ring-1 ring-inset",
                          o.sourceKind === "crawler"
                            ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
                            : o.sourceKind === "analyst"
                              ? "bg-amber-50 text-amber-800 ring-amber-600/30"
                              : o.sourceKind === "ai"
                                ? "bg-sky-50 text-sky-800 ring-sky-600/30"
                                : o.sourceKind === "manual"
                                  ? "bg-indigo-50 text-indigo-800 ring-indigo-600/30"
                                  : "bg-slate-100 text-slate-700 ring-slate-600/20",
                        )}
                      >
                        {SOURCE_KIND_LABEL[o.sourceKind]}
                      </span>
                      <span className="text-xs text-slate-500 tabular">
                        conf {o.confidence.toFixed(2)}
                      </span>
                      {o.modifierRequired && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-800">
                          <AlertTriangle className="h-3 w-3" aria-hidden /> needs modifier
                        </span>
                      )}
                      {o.priorAuthRequired && (
                        <span className="inline-flex items-center gap-1 text-xs text-red-800">
                          <AlertTriangle className="h-3 w-3" aria-hidden /> prior auth
                        </span>
                      )}
                      {o.hasFrequencyLimit && (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-700">
                          <AlertTriangle className="h-3 w-3" aria-hidden /> frequency limit
                        </span>
                      )}
                      {o.category && (
                        <span className="text-xs text-slate-400">
                          · {o.category}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* "Show all" toggle + override CTA */}
      {!noPayer && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="hover:underline"
          >
            {showAll
              ? "Hide off-allowlist entry"
              : "Need a code that isn't listed? Add anyway →"}
          </button>
          {loading && <span>Loading…</span>}
        </div>
      )}

      {/* Off-allowlist override modal */}
      {override && (
        <OverrideModal
          code={override.code}
          onCancel={() => setOverride(null)}
          onConfirm={(reason) => confirmOverride(override.code, reason)}
        />
      )}
    </div>
  );
}

function OverrideModal({
  code,
  onCancel,
  onConfirm,
}: {
  code: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="override-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
    >
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl p-5">
        <h2 id="override-title" className="text-base font-semibold">
          Add <span className="font-mono">{code}</span> outside the payer&rsquo;s allow-list?
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          We don&rsquo;t have a coverage rule on file for this code under the
          patient&rsquo;s payer in their state. You can still bill it — we&rsquo;ll
          log this override (with your reason) so the team can audit.
        </p>
        <label className="mt-3 block text-sm">
          <span className="text-slate-700">Why is this code appropriate?</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="e.g. Patient meets criteria per March 2026 plan amendment."
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim())}
          >
            Add with override
          </Button>
        </div>
      </div>
    </div>
  );
}
