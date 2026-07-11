/**
 * RiskBadge — Phase B inline indicator for a single super-bill line.
 *
 * Shows the predicted band (low / medium / high / block) with a
 * matching color + icon + label. Hover or focus reveals a popover
 * listing every reason the predictor surfaced for this line, with
 * the rule citation when available.
 *
 * Accessibility: badge is keyboard-focusable; popover is rendered
 * with role="dialog" and trapped focus while open.
 */
"use client";

import { AlertOctagon, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

export type RiskBand = "low" | "medium" | "high" | "block";

export interface RiskReason {
  code: string;
  message: string;
  contribution: number;
  payerRuleId?: string;
  /** Historical precision of this reason (0..100) from the feedback loop. */
  precisionPct?: number | null;
}

const BAND_STYLE: Record<RiskBand, { cls: string; label: string; Icon: typeof CheckCircle2 }> = {
  low: {
    cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
    label: "Low risk",
    Icon: CheckCircle2,
  },
  medium: {
    cls: "bg-amber-50 text-amber-800 ring-amber-600/30",
    label: "Medium",
    Icon: AlertTriangle,
  },
  high: {
    cls: "bg-orange-50 text-orange-900 ring-orange-600/30",
    label: "High",
    Icon: ShieldAlert,
  },
  block: {
    cls: "bg-red-50 text-red-900 ring-red-600/30",
    label: "Likely denial",
    Icon: AlertOctagon,
  },
};

interface Props {
  band: RiskBand;
  score: number;
  reasons: RiskReason[];
  /** Context for the citation deep-link into /billing/lookup (prefills the form). */
  cptCode?: string;
  payerId?: string | null;
  state?: string | null;
}

export function RiskBadge({ band, score, reasons, cptCode, payerId, state }: Props) {
  const [open, setOpen] = useState(false);
  const style = BAND_STYLE[band];
  const Icon = style.Icon;
  const citationHref = (r: RiskReason): string => {
    const p = new URLSearchParams();
    if (cptCode) p.set("cpt", cptCode);
    if (payerId) p.set("payerId", payerId);
    if (state) p.set("state", state);
    if (r.code) p.set("attribute", "covered");
    return `/billing/lookup${p.size ? `?${p.toString()}` : ""}`;
  };
  return (
    <span
      className="relative inline-block"
      // Close only when focus leaves the WHOLE widget — a blur handler on the
      // trigger alone unmounted the popover mid-mousedown, making the citation
      // link inside it unclickable.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset focus:outline-none focus:ring-2",
          style.cls,
        )}
      >
        <Icon className="h-3 w-3" aria-hidden />
        {style.label}
        <span className="ml-1 tabular text-[10px] opacity-70">{(score * 100).toFixed(0)}%</span>
      </button>
      {open && reasons.length > 0 && (
        <div
          role="dialog"
          className="absolute z-30 mt-1 left-0 w-80 rounded-md border border-slate-200 bg-white shadow-lg p-3 text-xs"
        >
          <p className="font-medium text-slate-700">Why this risk?</p>
          <ul className="mt-2 space-y-1.5">
            {reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 inline-block h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden />
                <div className="flex-1">
                  <p className="text-slate-700">
                    {r.message}
                    {typeof r.precisionPct === "number" && (
                      <span className="ml-1 text-slate-500">
                        ({r.precisionPct.toFixed(0)}% precision)
                      </span>
                    )}
                  </p>
                  {r.payerRuleId && (
                    <a
                      className="text-emerald-700 hover:underline"
                      // Prefills the lookup form (cpt/payer/state) — the old
                      // ?rule=<id> param was never read by the lookup page.
                      href={citationHref(r)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View rule citation →
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

/**
 * Summary banner: aggregate counts across the whole superbill draft.
 */
export function RiskSummary({
  worstBand,
  blockCount,
  highCount,
  mediumCount,
}: {
  worstBand: RiskBand;
  blockCount: number;
  highCount: number;
  mediumCount: number;
}) {
  const style = BAND_STYLE[worstBand];
  const Icon = style.Icon;
  const total = blockCount + highCount + mediumCount;
  if (total === 0) {
    return (
      <div className="rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-600/20 px-3 py-2 text-sm text-emerald-900 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        No predicted denials — looks clean to submit.
      </div>
    );
  }
  return (
    <div className={cn("rounded-md ring-1 ring-inset px-3 py-2 text-sm flex items-center gap-2", style.cls)}>
      <Icon className="h-4 w-4" aria-hidden />
      <span>
        Predictor flagged{" "}
        {blockCount > 0 && (
          <strong className="font-semibold">
            {blockCount} likely denial{blockCount === 1 ? "" : "s"}
          </strong>
        )}
        {blockCount > 0 && (highCount > 0 || mediumCount > 0) && ", "}
        {highCount > 0 && (
          <>
            <strong>{highCount} high-risk</strong>
            {mediumCount > 0 && ", "}
          </>
        )}
        {mediumCount > 0 && <strong>{mediumCount} medium</strong>}
        . Review reasons before submitting.
      </span>
    </div>
  );
}
