/**
 * /billing/denials/[id] — denial detail with AI analysis + decision flow.
 *
 * Source: pallio_complete_vision_v3 §6.5 + §8.4.
 *
 * Three sections:
 *   1. The denial signal (CARC + reason + amount)
 *   2. AI analysis panel (lazy-loaded; "Analyze" button if not run yet)
 *   3. Decision controls (refile / write_off / appeal) + outcome recording
 */
"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { lookupCarc } from "@/lib/features/denials/denial-pure";
import type {
  AiRecommendation,
  DenialView,
} from "@/lib/features/denials/denial.types";

export default function DenialDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [denial, setDenial] = useState<DenialView | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/denials/${id}`);
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Not found.");
        return;
      }
      setDenial(data.data);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function analyze() {
    setAnalyzing(true);
    setError(null);
    try {
      const r = await fetch(`/api/denials/${id}/analyze`, { method: "POST" });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Analyze failed.");
      }
      await load();
    } catch {
      setError("Network error.");
    } finally {
      setAnalyzing(false);
    }
  }

  async function decide(decision: "refile" | "write_off" | "appeal") {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/denials/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Decide failed.");
      }
      await load();
    } catch {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;
  if (error && !denial)
    return (
      <div className="px-8 py-8">
        <p className="text-red-700">{error}</p>
        <Link
          href="/billing/denials"
          className="mt-4 inline-block text-[var(--color-brand-700)] underline"
        >
          ← Denials
        </Link>
      </div>
    );
  if (!denial) return null;

  const carc = lookupCarc(denial.carcCode);

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <Link href="/billing/denials" className="text-xs text-slate-500 hover:underline">
          ← Denials
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">
          Denial · CPT {denial.cptCode}
        </h1>
        <p className="text-slate-600 mt-1 tabular text-sm">
          Denied {denial.deniedAt.slice(0, 10)} · ${(denial.deniedAmountCents / 100).toFixed(2)}{" "}
          · {denial.decision}
        </p>
      </header>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Denial signal</CardTitle>
          <CardDescription>What the EOB said.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-slate-700">
          <Row label="CPT" value={denial.cptCode} mono />
          <Row label="CARC" value={`${denial.carcCode} — ${carc.text}`} />
          {denial.rarcCode && <Row label="RARC" value={denial.rarcCode} mono />}
          {denial.denialReason && <Row label="Payer text" value={denial.denialReason} />}
          <Row
            label="Denied amount"
            value={`$${(denial.deniedAmountCents / 100).toFixed(2)}`}
            mono
          />
          {denial.icd10Codes.length > 0 && (
            <Row label="ICD-10" value={denial.icd10Codes.join(", ")} mono />
          )}
        </CardContent>
      </Card>

      <Card
        className="mb-4"
        severity={
          denial.aiRecommendation === "appeal"
            ? "warn"
            : denial.aiRecommendation === "refile"
              ? "success"
              : denial.aiRecommendation === "write_off"
                ? "info"
                : "info"
        }
      >
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>AI analysis</CardTitle>
            <div className="flex items-center gap-2">
              {denial.aiRecommendation && (
                <RecommendationPill rec={denial.aiRecommendation} />
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={analyze}
                loading={analyzing}
              >
                {denial.aiAnalysisText ? "Re-analyze" : "Analyze"}
              </Button>
            </div>
          </div>
          {denial.aiModelVersion && (
            <CardDescription>
              Model: <code className="text-xs">{denial.aiModelVersion}</code>
              {denial.aiAnalyzedAt && (
                <>
                  {" · "}
                  {new Date(denial.aiAnalyzedAt).toLocaleString()}
                </>
              )}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {!denial.aiAnalysisText ? (
            <p className="text-sm text-slate-500">
              No analysis yet. Click &ldquo;Analyze&rdquo; to run the denial analyst against the
              payer rule.
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              {denial.aiLikelyCause && (
                <p className="text-slate-900 font-medium">
                  Likely cause: {denial.aiLikelyCause}
                </p>
              )}
              <p className="text-slate-700 whitespace-pre-wrap">{denial.aiAnalysisText}</p>
              {denial.aiCitationDocName && denial.aiCitationQuote && (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                    Source citation
                  </div>
                  <div className="text-xs text-slate-700">
                    {denial.aiCitationDocName}
                  </div>
                  <blockquote className="mt-1 border-l-4 border-l-slate-300 bg-slate-50 px-3 py-2 italic text-xs text-slate-700">
                    &ldquo;{denial.aiCitationQuote}&rdquo;
                  </blockquote>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decision</CardTitle>
          <CardDescription>
            Refile = re-submit corrected claim. Appeal = formal letter. Write-off = absorb the cost.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {denial.decision === "pending" ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => decide("refile")} loading={submitting}>
                Refile
              </Button>
              <Button variant="secondary" onClick={() => decide("appeal")} loading={submitting}>
                Appeal
              </Button>
              <Button variant="secondary" onClick={() => decide("write_off")} loading={submitting}>
                Write off
              </Button>
            </div>
          ) : (
            <div className="text-sm">
              <p className="text-slate-700 mb-1">
                <strong className="capitalize">{denial.decision.replace("_", " ")}</strong>
                {denial.decisionAt && (
                  <span className="text-slate-500 tabular">
                    {" · "}
                    {new Date(denial.decisionAt).toLocaleString()}
                  </span>
                )}
              </p>
              {denial.decisionNotes && (
                <p className="text-slate-600 text-xs italic">{denial.decisionNotes}</p>
              )}
            </div>
          )}

          {denial.outcome !== "pending" && (
            <div className="mt-4 pt-4 border-t border-slate-100 text-sm">
              <p className="text-slate-700">
                Outcome: <strong className="capitalize">{denial.outcome.replace("_", " ")}</strong>
                {denial.outcomeAt && (
                  <span className="text-slate-500 tabular">
                    {" · "}
                    {new Date(denial.outcomeAt).toLocaleString()}
                  </span>
                )}
                {denial.outcomeAmountCents !== null && (
                  <span className="text-slate-500 tabular">
                    {" · $"}
                    {(denial.outcomeAmountCents / 100).toFixed(2)}
                  </span>
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <p role="alert" className="mt-4 text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={mono ? "font-mono tabular text-xs" : ""}>{value}</span>
    </div>
  );
}

function RecommendationPill({ rec }: { rec: AiRecommendation }) {
  const map: Record<AiRecommendation, { cls: string; label: string }> = {
    refile: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/30", label: "Refile" },
    appeal: { cls: "bg-amber-50 text-amber-800 ring-amber-600/30", label: "Appeal" },
    write_off: { cls: "bg-slate-100 text-slate-700 ring-slate-600/20", label: "Write off" },
    unknown: { cls: "bg-slate-100 text-slate-600 ring-slate-600/20", label: "Unknown" },
  };
  const m = map[rec];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${m.cls}`}
    >
      AI says: {m.label}
    </span>
  );
}
