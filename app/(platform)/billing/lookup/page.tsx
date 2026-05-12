/**
 * /billing/lookup — billing agent's primary tool.
 *
 * Source: pallio_complete_vision_v3 §8.2.
 *
 * The form supports both structured input (payer dropdown + state +
 * CPT code) and natural-language input ("Does Humana Ohio cover 99349
 * telehealth?"). The latter uses haiku to extract structured params,
 * then the standard SQL → vector → Claude flow.
 *
 * Result panel renders the CoverageBadge, confidence chip, and a
 * collapsible source-citation panel with the verbatim quote per
 * §5.1's hallucination-prevention rules.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CoverageBadge,
  type CoverageStatus,
} from "@/components/ui/coverage-badge";

type LookupResult = {
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
  missing?: string[];
  resolved: {
    payerId: string | null;
    state: string | null;
    cptCode: string | null;
    attribute: string | null;
  };
};

type Payer = { id: string; name: string; type: string; states: string[] };

const ATTRIBUTES = [
  ["covered", "Covered?"],
  ["prior_auth", "Prior auth required?"],
  ["telehealth", "Telehealth allowed?"],
  ["provider_type", "Provider type restrictions?"],
  ["billing_limit", "Billing limit / unit cap?"],
  ["addon_compatible", "Add-on code compatibility?"],
  ["documentation", "Documentation requirements?"],
  ["frequency_limit", "Frequency limit?"],
  ["modifier_required", "Modifier required?"],
] as const;

export default function LookupPage() {
  const [query, setQuery] = useState("");
  const [payerId, setPayerId] = useState("");
  const [state, setState] = useState("");
  const [cptCode, setCptCode] = useState("");
  const [attribute, setAttribute] = useState<string>("covered");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCitation, setShowCitation] = useState(true);
  const [payers, setPayers] = useState<Payer[]>([]);

  useEffect(() => {
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setPayers(d.data?.rows ?? d.data ?? []);
      })
      .catch(() => undefined);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/billing/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query || undefined,
          payerId: payerId || undefined,
          state: state || undefined,
          cptCode: cptCode || undefined,
          attribute,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Lookup failed.");
        return;
      }
      setResult(data.data as LookupResult);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-8 py-8 max-w-5xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Rule lookup</h1>
        <p className="text-slate-600 mt-1">
          For this payer × state × CPT, what are the rules? Every answer is
          either cited or marked unknown — no synthesis without a source.
        </p>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Ask</CardTitle>
          <CardDescription>
            Use natural language or fill in the structured fields.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <label
                htmlFor="query"
                className="text-sm font-medium text-slate-700"
              >
                Question (optional)
              </label>
              <input
                id="query"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Does Humana Ohio cover 99349 telehealth?"
                className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="payer"
                  className="text-sm font-medium text-slate-700"
                >
                  Payer
                </label>
                <select
                  id="payer"
                  value={payerId}
                  onChange={(e) => setPayerId(e.target.value)}
                  className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
                >
                  <option value="">(any / pick…)</option>
                  {payers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.states && p.states.length ? ` · ${p.states.slice(0, 3).join("/")}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="state"
                  className="text-sm font-medium text-slate-700"
                >
                  State
                </label>
                <input
                  id="state"
                  type="text"
                  maxLength={2}
                  value={state}
                  onChange={(e) => setState(e.target.value.toUpperCase())}
                  placeholder="OH"
                  className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base uppercase tabular focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="cpt"
                  className="text-sm font-medium text-slate-700"
                >
                  CPT / HCPCS
                </label>
                <input
                  id="cpt"
                  type="text"
                  value={cptCode}
                  onChange={(e) => setCptCode(e.target.value.toUpperCase())}
                  placeholder="99349"
                  className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base tabular slashed-zero focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="attribute"
                className="text-sm font-medium text-slate-700"
              >
                Rule attribute
              </label>
              <select
                id="attribute"
                value={attribute}
                onChange={(e) => setAttribute(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
              >
                {ATTRIBUTES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <p
                role="alert"
                className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-md ring-1 ring-inset ring-red-600/20"
              >
                {error}
              </p>
            )}

            <Button type="submit" loading={submitting}>
              Ask
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card
          severity={
            result.coverageStatus === "not_covered"
              ? "error"
              : result.coverageStatus === "varies"
                ? "warn"
                : result.coverageStatus === "covered"
                  ? "success"
                  : "info"
          }
        >
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Result</CardTitle>
              <div className="flex items-center gap-2">
                <CoverageBadge status={result.coverageStatus} />
                <span
                  className="text-xs px-2 py-1 rounded-md bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300 tabular"
                  title={`Source: ${result.source}`}
                >
                  {result.source === "ai_synthesized"
                    ? "AI synthesized"
                    : result.source === "structured_rule"
                      ? "Confirmed rule"
                      : "Unknown"}
                </span>
                {result.confidence > 0 && (
                  <span className="text-xs px-2 py-1 rounded-md bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300 tabular">
                    confidence {(result.confidence * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
            {result.missing && result.missing.length > 0 && (
              <CardDescription>
                Need: {result.missing.join(", ")}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <p className="text-base text-slate-900 whitespace-pre-wrap">
              {result.answer}
            </p>

            {result.citation && (
              <div className="mt-5 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCitation((s) => !s)}
                  className="text-sm font-medium text-slate-700 hover:text-slate-900 inline-flex items-center gap-1"
                  aria-expanded={showCitation}
                >
                  Source citation {showCitation ? "▾" : "▸"}
                </button>
                {showCitation && (
                  <div className="mt-2 space-y-2 text-sm">
                    <div className="text-slate-600">
                      <span className="font-medium text-slate-800">
                        Document:
                      </span>{" "}
                      {result.citation.documentUrl ? (
                        <a
                          href={result.citation.documentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--color-brand-700)] underline"
                        >
                          {result.citation.documentName}
                        </a>
                      ) : (
                        result.citation.documentName
                      )}
                      {result.citation.effectiveDate && (
                        <span className="text-slate-500 tabular">
                          {" "}
                          (effective {result.citation.effectiveDate})
                        </span>
                      )}
                      {result.citation.page !== null && (
                        <span className="text-slate-500 tabular">
                          {" "}
                          — page {result.citation.page}
                        </span>
                      )}
                    </div>
                    <blockquote className="border-l-4 border-l-slate-300 bg-slate-50 px-4 py-3 text-slate-800 italic text-sm">
                      “{result.citation.verbatimQuote}”
                    </blockquote>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
