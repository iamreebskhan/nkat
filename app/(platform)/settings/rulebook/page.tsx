/**
 * /settings/rulebook — the org's billing rulebook editor.
 *
 * Source: pallio_complete_vision_v3 §9.3 (Path A) + §9.4 (Path B) + §9.5.
 *
 * Path A flow:
 *   - Click "Generate" → POST /api/rulebook/generate
 *   - Edit cells inline (coverage_status + freeform note)
 *   - Click "Save" / "Save + finalize" → POST /api/rulebook/save
 *
 * Path B flow (deferred to a follow-up):
 *   - Upload PDF/DOCX/XLSX → POST /api/rulebook/upload
 *   - Side-by-side diff view (uses lib/features/rulebook/rulebook-pure)
 *   - Per-row: accept source / keep org / custom
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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
import type {
  RulebookRowView,
  RulebookView,
} from "@/lib/features/rulebook/rulebook.types";

interface PendingEdit {
  rowId: string;
  ruleValue: Record<string, unknown>;
  coverageStatus: CoverageStatus;
}

export default function RulebookPage() {
  const [rb, setRb] = useState<RulebookView | null>(null);
  const [edits, setEdits] = useState<Record<string, PendingEdit>>({});
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/rulebook");
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Failed to load.");
        return;
      }
      setRb(data.data.rulebook);
      setEdits({});
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Auto-generate when ?init=generate (from the onboarding wizard).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("init") === "generate") {
      void generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    setInfo(null);
    try {
      const r = await fetch("/api/rulebook/generate", { method: "POST" });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Generation failed.");
        return;
      }
      setRb(data.data.rulebook);
      setEdits({});
      setInfo(`Generated ${data.data.rulebook.rows.length} rules from sources.`);
    } catch {
      setError("Network error.");
    } finally {
      setGenerating(false);
    }
  }

  function setCellEdit(rowId: string, edit: PendingEdit) {
    setEdits((prev) => ({ ...prev, [rowId]: edit }));
  }

  async function save(finalize: boolean) {
    if (Object.keys(edits).length === 0 && !finalize) {
      setInfo("No changes to save.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/rulebook/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edits: Object.values(edits),
          finalize,
        }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        return;
      }
      setInfo(
        `${data.data.updated} cell${data.data.updated === 1 ? "" : "s"} saved${
          data.data.finalized ? " · rulebook finalized" : ""
        }.`,
      );
      await load();
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  const groups = useMemo(() => groupByPayerState(rb?.rows ?? []), [rb]);

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;

  const empty = !rb || rb.rows.length === 0;

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Org rulebook</h1>
          <p className="text-slate-600 mt-1 tabular text-sm">
            {rb && rb.id
              ? `v${rb.currentVersion} · ${rb.rows.length} rules · origin: ${rb.origin}`
              : "Not generated yet"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={generate} loading={generating}>
            {empty ? "Generate" : "Re-generate from sources"}
          </Button>
          <Button onClick={() => save(false)} loading={saving} disabled={empty}>
            Save edits
          </Button>
          <Button onClick={() => save(true)} loading={saving} disabled={empty}>
            Save + finalize
          </Button>
        </div>
      </header>

      {info && (
        <p className="mb-4 px-3 py-2 rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-600/20 text-sm text-emerald-800">
          {info}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-4 px-3 py-2 rounded-md bg-red-50 ring-1 ring-inset ring-red-600/20 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      {empty ? (
        <Card>
          <CardHeader>
            <CardTitle>Build your rulebook</CardTitle>
            <CardDescription>
              We&rsquo;ll query the source library for every payer × state × CPT
              combo you selected during onboarding.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={generate} loading={generating}>
              Generate now
            </Button>
            <p className="text-xs text-slate-500 mt-3">
              Or{" "}
              <Link
                href="/onboarding"
                className="text-[var(--color-brand-700)] underline"
              >
                revisit the onboarding wizard
              </Link>{" "}
              to adjust active states / payers / CPT codes.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map(({ key, payerId, state, items }) => (
            <Card key={key}>
              <CardHeader>
                <CardTitle className="text-lg">
                  <span className="tabular text-slate-700">{state}</span>{" "}
                  <span className="text-slate-500 text-sm font-normal font-mono ml-2">
                    payer {payerId.slice(0, 8)}…
                  </span>
                </CardTitle>
                <CardDescription>
                  {items.length} rule{items.length === 1 ? "" : "s"}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-semibold px-4 py-2">CPT</th>
                      <th className="text-left font-semibold px-4 py-2">Attribute</th>
                      <th className="text-left font-semibold px-4 py-2">Coverage</th>
                      <th className="text-left font-semibold px-4 py-2">Origin</th>
                      <th className="text-left font-semibold px-4 py-2">Confidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((row) => {
                      const edit = edits[row.id];
                      const status = edit?.coverageStatus ?? row.coverageStatus;
                      return (
                        <tr key={row.id}>
                          <td className="px-4 py-1.5 font-mono tabular text-xs text-slate-900">
                            {row.cptCode}
                          </td>
                          <td className="px-4 py-1.5 text-slate-700">
                            {row.attribute.replace(/_/g, " ")}
                          </td>
                          <td className="px-4 py-1.5">
                            <select
                              value={status}
                              onChange={(e) =>
                                setCellEdit(row.id, {
                                  rowId: row.id,
                                  ruleValue: row.ruleValue,
                                  coverageStatus: e.target
                                    .value as CoverageStatus,
                                })
                              }
                              className="h-7 px-2 text-xs rounded border border-slate-300 bg-white"
                              aria-label={`Coverage for ${row.cptCode}`}
                            >
                              <option value="covered">Covered</option>
                              <option value="not_covered">Not covered</option>
                              <option value="varies">Varies</option>
                              <option value="unknown">Unknown</option>
                            </select>
                            <span className="ml-2 align-middle">
                              <CoverageBadge status={status} size="sm" />
                            </span>
                          </td>
                          <td className="px-4 py-1.5 text-xs text-slate-600">
                            {edit ? "edited" : row.origin.replace(/_/g, " ")}
                          </td>
                          <td className="px-4 py-1.5 text-xs tabular text-slate-600">
                            {(row.confidence * 100).toFixed(0)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByPayerState(rows: RulebookRowView[]) {
  const map = new Map<
    string,
    { key: string; payerId: string; state: string; items: RulebookRowView[] }
  >();
  for (const row of rows) {
    const k = `${row.payerId ?? "ANY"}:${row.state}`;
    const g = map.get(k) ?? {
      key: k,
      payerId: row.payerId ?? "ANY",
      state: row.state,
      items: [],
    };
    g.items.push(row);
    map.set(k, g);
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      a.state.localeCompare(b.state) || a.payerId.localeCompare(b.payerId),
  );
}
