/**
 * RuleSidebar — surfaces payer rules at the point of documentation.
 *
 * Source: pallio_complete_vision_v3 §5.2 ("Integrated Billing at Point
 * of Documentation").
 *
 *   "When a clinician is documenting a visit, the system checks the
 *    patient's insurance and surfaces relevant payer rules in a
 *    sidebar panel."
 *
 * Given (payerId, state, [cptCodes]) the component runs one rule
 * lookup per code via /api/billing/lookup and renders the result
 * with a `CoverageBadge` + collapsible source citation.
 *
 * Skipped silently if `payerId` or `state` is missing — the rule
 * lookup needs both. Skipped when `cptCodes` is empty.
 */
"use client";

import { useEffect, useState } from "react";

import {
  CoverageBadge,
  type CoverageStatus,
} from "@/components/ui/coverage-badge";

interface RuleResult {
  status: "ok" | "needs_clarification" | "unknown";
  source: "structured_rule" | "ai_synthesized" | "unknown";
  answer: string;
  coverageStatus: CoverageStatus;
  confidence: number;
  citation: {
    documentName: string;
    documentUrl: string | null;
    effectiveDate: string | null;
    verbatimQuote: string;
    page: number | null;
  } | null;
}

type Props = {
  payerId: string | null | undefined;
  state: string | null | undefined;
  cptCodes: string[];
  /** Drives which rule attribute we ask about. Defaults to "covered". */
  attribute?:
    | "covered"
    | "prior_auth"
    | "telehealth"
    | "provider_type"
    | "billing_limit"
    | "addon_compatible"
    | "documentation"
    | "frequency_limit"
    | "modifier_required";
};

export function RuleSidebar({ payerId, state, cptCodes, attribute = "covered" }: Props) {
  const [results, setResults] = useState<Record<string, RuleResult | null>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!payerId || !state || cptCodes.length === 0) {
      setResults({});
      return;
    }
    let abandoned = false;
    setLoading(true);
    (async () => {
      const next: Record<string, RuleResult | null> = {};
      // Sequential not parallel — keeps server load in check + each
      // request potentially fires Anthropic. The clinician sees results
      // populate in document order.
      for (const code of cptCodes) {
        if (abandoned) return;
        try {
          const r = await fetch("/api/billing/lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payerId, state, cptCode: code, attribute }),
          });
          const data = await r.json();
          next[code] = data.success ? (data.data as RuleResult) : null;
        } catch {
          next[code] = null;
        }
      }
      if (!abandoned) {
        setResults(next);
        setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [payerId, state, cptCodes.join(","), attribute]);

  if (!payerId || !state) {
    return (
      <p className="text-xs text-slate-500 px-3 py-2 bg-slate-50 rounded">
        Add the patient&rsquo;s primary payer + state to see rules here.
      </p>
    );
  }

  if (cptCodes.length === 0) {
    return (
      <p className="text-xs text-slate-500 px-3 py-2 bg-slate-50 rounded">
        Suggested codes appear once the timer or visit type is set.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {loading && Object.keys(results).length === 0 && (
        <p className="text-xs text-slate-500">Checking payer rules…</p>
      )}
      {cptCodes.map((code) => {
        const r = results[code];
        return (
          <div
            key={code}
            className="px-3 py-2 rounded-md bg-slate-50 ring-1 ring-inset ring-slate-200"
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs font-mono font-bold tabular text-slate-900">
                {code}
              </span>
              {r ? (
                <CoverageBadge status={r.coverageStatus} size="sm" />
              ) : (
                <span className="text-xs text-slate-400">checking…</span>
              )}
            </div>
            {r && r.answer && (
              <p className="text-xs text-slate-700 leading-snug line-clamp-3">
                {r.answer}
              </p>
            )}
            {r?.citation?.verbatimQuote && (
              <p
                className="mt-1 text-[10px] text-slate-500 italic line-clamp-2"
                title={r.citation.verbatimQuote}
              >
                &ldquo;{r.citation.verbatimQuote}&rdquo;
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
