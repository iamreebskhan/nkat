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
 * Path B flow (live):
 *   - Upload a rulebook CSV → POST /api/rulebook/upload
 *   - Side-by-side diff view → GET /api/rulebook/comparison
 *   - Per-row: accept source / keep org → POST /api/rulebook/merge
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
  const [canAttest, setCanAttest] = useState(false);
  /** Expanded CPT detail cards keyed by `${payerKey}:${cptCode}`. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Per-row "Flag for attestation" pending state. */
  const [flagBusy, setFlagBusy] = useState<Record<string, boolean>>({});

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function flagForAttestation(row: RulebookRowView) {
    setFlagBusy((b) => ({ ...b, [row.id]: true }));
    try {
      const r = await fetch("/api/attestations/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payerId: row.payerId,
          state: row.state,
          cptCode: row.cptCode,
          attribute: row.attribute,
          sourceQuery: `rulebook UI: ${row.payerName ?? row.payerId} · ${row.state} · ${row.cptCode} · ${row.attribute}`,
        }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error ?? "Flag failed");
      setInfo(`Flagged ${row.cptCode}/${row.attribute} for analyst attestation.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Flag failed");
    } finally {
      setFlagBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

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
    // Analysts (internal staff) keep one-click access to the
    // attestation queue now that /payers redirects here.
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setCanAttest(d.data.permissions?.includes("knowledge.attest") ?? false);
      })
      .catch(() => {});
  }, []);

  // Auto-generate when ?init=generate (from the onboarding wizard).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("init") === "generate") {
      void generate();
    }
     
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
          <h1 className="font-display text-3xl tracking-tight">Rulebook</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-2xl">
            Your account&rsquo;s billing rulebook. Generate it from Pallio&rsquo;s
            reference library or upload your own, reconcile the two, edit,
            and finalize. This is private to your organization.
          </p>
          <p className="text-slate-500 mt-1 tabular text-xs">
            {rb && rb.id
              ? `v${rb.currentVersion} · ${rb.rows.length} rules · origin: ${rb.origin}`
              : "Not generated yet"}
            {canAttest && (
              <>
                {" · "}
                <Link
                  href="/payers/attestations"
                  className="text-[var(--color-brand-700)] underline"
                >
                  Attestations queue →
                </Link>
              </>
            )}
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

      <PathBUpload onMerged={() => { void load(); }} />

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
          {groups.map((g) => (
            <Card key={g.key}>
              <CardHeader>
                <CardTitle className="text-lg">
                  {g.payerName ?? <span className="text-slate-500">Unknown payer</span>}
                  <span className="text-slate-500 text-sm font-normal ml-3">
                    · <span className="tabular">{g.state}</span>
                    {g.payerType && <> · {prettyPayerType(g.payerType)}</>}
                  </span>
                </CardTitle>
                <CardDescription>
                  {g.cpts.length} code{g.cpts.length === 1 ? "" : "s"} ·{" "}
                  {g.cpts.reduce((n, c) => n + c.attrs.length, 0)} rules
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-semibold px-4 py-2 w-6"></th>
                      <th className="text-left font-semibold px-4 py-2">CPT</th>
                      <th className="text-left font-semibold px-4 py-2">Description</th>
                      <th className="text-left font-semibold px-4 py-2">Coverage</th>
                      <th className="text-left font-semibold px-4 py-2">Rules</th>
                      <th className="text-left font-semibold px-4 py-2">Confidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {g.cpts.map((cpt) => (
                      <CptRows
                        key={`${g.key}:${cpt.cptCode}`}
                        cpt={cpt}
                        payerId={g.payerId}
                        state={g.state}
                        expanded={expanded.has(`${g.key}:${cpt.cptCode}`)}
                        toggle={() => toggleExpand(`${g.key}:${cpt.cptCode}`)}
                        edits={edits}
                        setCellEdit={setCellEdit}
                        flagForAttestation={flagForAttestation}
                        flagBusy={flagBusy}
                      />
                    ))}
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

interface CptGroup {
  cptCode: string;
  cptDescription: string | null;
  codeSystem: string | null;
  attrs: RulebookRowView[];
}
interface PayerStateGroup {
  key: string;
  payerId: string;
  payerName: string | null;
  payerType: string | null;
  state: string;
  cpts: CptGroup[];
}

function groupByPayerState(rows: RulebookRowView[]): PayerStateGroup[] {
  const byPayer = new Map<string, PayerStateGroup>();
  for (const row of rows) {
    const k = `${row.payerId ?? "ANY"}:${row.state}`;
    let g = byPayer.get(k);
    if (!g) {
      g = {
        key: k,
        payerId: row.payerId ?? "ANY",
        payerName: row.payerName,
        payerType: row.payerType,
        state: row.state,
        cpts: [],
      };
      byPayer.set(k, g);
    }
    let cpt = g.cpts.find((c) => c.cptCode === row.cptCode);
    if (!cpt) {
      cpt = {
        cptCode: row.cptCode,
        cptDescription: row.cptDescription,
        codeSystem: row.codeSystem,
        attrs: [],
      };
      g.cpts.push(cpt);
    }
    cpt.attrs.push(row);
  }
  for (const g of byPayer.values()) {
    g.cpts.sort((a, b) => a.cptCode.localeCompare(b.cptCode));
    for (const c of g.cpts) c.attrs.sort((a, b) => a.attribute.localeCompare(b.attribute));
  }
  return Array.from(byPayer.values()).sort(
    (a, b) =>
      a.state.localeCompare(b.state) ||
      (a.payerName ?? "").localeCompare(b.payerName ?? "") ||
      a.payerId.localeCompare(b.payerId),
  );
}

/** Map payer_type DB enum → human label. */
function prettyPayerType(t: string): string {
  const m: Record<string, string> = {
    commercial: "Commercial",
    medicaid_mco: "Medicaid MCO",
    medicaid_state: "Medicaid",
    medicare_mac: "Medicare",
    medicare_advantage_org: "Medicare Advantage",
    tpa: "TPA",
    workers_comp: "Workers' Comp",
    auto_no_fault: "Auto / No-fault",
    tribal: "Tribal / IHS",
    self_insured: "Self-insured",
    other: "Other",
  };
  return m[t] ?? t;
}

// ---------------------------------------------------------------------------
// One pivoted summary row per CPT + optional expanded detail row showing
// every attribute as a sub-row with inline editor + "Flag for attestation".
// ---------------------------------------------------------------------------

function CptRows(props: {
  cpt: CptGroup;
  payerId: string;
  state: string;
  expanded: boolean;
  toggle: () => void;
  edits: Record<string, PendingEdit>;
  setCellEdit: (rowId: string, edit: PendingEdit) => void;
  flagForAttestation: (row: RulebookRowView) => Promise<void>;
  flagBusy: Record<string, boolean>;
}) {
  const { cpt, expanded, toggle, edits, setCellEdit, flagForAttestation, flagBusy } = props;
  // Headline coverage = the "covered" attribute if present, else the first attr.
  const primary = cpt.attrs.find((a) => a.attribute === "covered") ?? cpt.attrs[0];
  const primaryStatus =
    (primary && (edits[primary.id]?.coverageStatus ?? primary.coverageStatus)) ??
    "unknown";
  // Confidence shown is the max across attrs (best evidence we have for this CPT).
  const maxConfidence = Math.max(...cpt.attrs.map((a) => a.confidence ?? 0));

  return (
    <>
      <tr className="hover:bg-slate-50/50">
        <td className="px-4 py-2 text-slate-400">
          <button
            onClick={toggle}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-slate-200"
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td className="px-4 py-2 font-mono tabular text-xs text-slate-900">{cpt.cptCode}</td>
        <td className="px-4 py-2 text-slate-700">
          {cpt.cptDescription ?? <span className="text-slate-400 italic">no descriptor</span>}
        </td>
        <td className="px-4 py-2">
          <CoverageBadge status={primaryStatus} size="sm" />
        </td>
        <td className="px-4 py-2 text-xs text-slate-600">
          {cpt.attrs.length} attribute{cpt.attrs.length === 1 ? "" : "s"}
        </td>
        <td className="px-4 py-2 text-xs tabular text-slate-600">
          {(maxConfidence * 100).toFixed(0)}%
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={6} className="bg-slate-50/50 px-4 py-3">
            <div className="space-y-2">
              {cpt.attrs.map((row) => {
                const edit = edits[row.id];
                const status = edit?.coverageStatus ?? row.coverageStatus;
                const value = (edit?.ruleValue ?? row.ruleValue) as Record<
                  string,
                  unknown
                >;
                const notes = (value.notes as string | undefined) ?? "";
                const source = (value.source as string | undefined) ?? "";
                const verifiedBy = (value.verifiedBy as string | undefined) ?? "";
                const answer = (value.answer as string | undefined) ?? "";
                const isUnknown = status === "unknown";
                return (
                  <div
                    key={row.id}
                    className="rounded border border-slate-200 bg-white p-3 text-sm"
                  >
                    <div className="flex items-center justify-between mb-2 gap-3">
                      <div className="font-medium text-slate-800">
                        {row.attribute.replace(/_/g, " ")}
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={status}
                          onChange={(e) =>
                            setCellEdit(row.id, {
                              rowId: row.id,
                              ruleValue: value,
                              coverageStatus: e.target.value as CoverageStatus,
                            })
                          }
                          className="h-7 px-2 text-xs rounded border border-slate-300 bg-white"
                          aria-label={`Coverage for ${row.cptCode} ${row.attribute}`}
                        >
                          <option value="covered">Covered</option>
                          <option value="not_covered">Not covered</option>
                          <option value="varies">Varies</option>
                          <option value="unknown">Unknown</option>
                        </select>
                        <CoverageBadge status={status} size="sm" />
                        <span className="text-xs tabular text-slate-500 ml-1">
                          {(row.confidence * 100).toFixed(0)}%
                        </span>
                        <span className="text-xs text-slate-500">
                          · {edit ? "edited" : row.origin.replace(/_/g, " ")}
                        </span>
                      </div>
                    </div>

                    {answer && (
                      <p className="text-xs text-slate-700 mb-2">{answer}</p>
                    )}
                    {row.sourceQuote && !edit && (
                      <p className="text-xs italic text-slate-500 mb-2 border-l-2 border-slate-200 pl-2">
                        &ldquo;{row.sourceQuote}&rdquo;
                      </p>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <label className="block">
                        <span className="block text-[11px] font-medium text-slate-600 mb-0.5">
                          Notes
                        </span>
                        <textarea
                          rows={2}
                          value={notes}
                          onChange={(e) =>
                            setCellEdit(row.id, {
                              rowId: row.id,
                              ruleValue: { ...value, notes: e.target.value },
                              coverageStatus: status,
                            })
                          }
                          placeholder='e.g. "Confirmed by payer call 12 May 2026"'
                          className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
                        />
                      </label>
                      <div className="space-y-1">
                        <label className="block">
                          <span className="block text-[11px] font-medium text-slate-600 mb-0.5">
                            Source
                          </span>
                          <select
                            value={source}
                            onChange={(e) =>
                              setCellEdit(row.id, {
                                rowId: row.id,
                                ruleValue: { ...value, source: e.target.value || undefined },
                                coverageStatus: status,
                              })
                            }
                            className="w-full h-7 px-2 text-xs rounded border border-slate-300 bg-white"
                          >
                            <option value="">—</option>
                            <option value="payer_call">Payer call</option>
                            <option value="contract">Contract document</option>
                            <option value="portal">Provider portal</option>
                            <option value="other">Other</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="block text-[11px] font-medium text-slate-600 mb-0.5">
                            Verified by
                          </span>
                          <input
                            value={verifiedBy}
                            onChange={(e) =>
                              setCellEdit(row.id, {
                                rowId: row.id,
                                ruleValue: {
                                  ...value,
                                  verifiedBy: e.target.value || undefined,
                                  verifiedAt: e.target.value
                                    ? new Date().toISOString().slice(0, 10)
                                    : undefined,
                                },
                                coverageStatus: status,
                              })
                            }
                            placeholder="Your name"
                            className="w-full h-7 px-2 text-xs rounded border border-slate-300 bg-white"
                          />
                        </label>
                      </div>
                    </div>

                    {isUnknown && (
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => flagForAttestation(row)}
                          disabled={flagBusy[row.id]}
                          className="text-xs px-2 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          {flagBusy[row.id]
                            ? "Flagging…"
                            : "🔔 Flag for analyst attestation"}
                        </button>
                        <span className="text-[11px] text-slate-500">
                          Pushes this to /payers/attestations for an analyst to confirm.
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Path B — upload an existing rulebook CSV, reconcile against the source
// library, accept per-row.
// ---------------------------------------------------------------------------

interface ComparisonRow {
  payerId: string | null;
  state: string;
  cptCode: string;
  attribute: string;
  orgValue: { coverageStatus: CoverageStatus; ruleValue: Record<string, unknown> } | null;
  sourceValue: {
    coverageStatus: CoverageStatus;
    ruleValue: Record<string, unknown>;
    sourceQuote: string | null;
    sourcePayerRuleId: string | null;
  } | null;
  outcome: "match" | "diff" | "unverified" | "new_from_pallio";
}

const OUTCOME_STYLE: Record<ComparisonRow["outcome"], string> = {
  match: "bg-emerald-50 text-emerald-700",
  diff: "bg-amber-50 text-amber-800",
  unverified: "bg-slate-100 text-slate-600",
  new_from_pallio: "bg-sky-50 text-sky-700",
};

function PathBUpload({ onMerged }: { onMerged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<ComparisonRow[] | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  // decision per row index: "source" | "org"
  const [picks, setPicks] = useState<Record<number, "source" | "org">>({});

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    setRows(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "rulebook");
      const up = await fetch("/api/rulebook/upload", { method: "POST", body: fd });
      const ud = await up.json();
      if (!ud.success) throw new Error(ud.error ?? "Upload failed");
      setUploadId(ud.data.uploadId);
      setMsg(
        `Parsed ${ud.data.parsedRowCount} rows (${ud.data.resolvedPayers} payers resolved)` +
          (ud.data.errors?.length ? ` · ${ud.data.errors.length} skipped` : ""),
      );
      const cmp = await fetch(
        `/api/rulebook/comparison?uploadId=${ud.data.uploadId}`,
      );
      const cd = await cmp.json();
      if (!cd.success) throw new Error(cd.error ?? "Comparison failed");
      setRows(cd.data.rows);
      // default pick: take source where it exists, else keep org
      const def: Record<number, "source" | "org"> = {};
      (cd.data.rows as ComparisonRow[]).forEach((r, i) => {
        def[i] = r.sourceValue ? "source" : "org";
      });
      setPicks(def);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Upload failed");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  async function applyDecisions() {
    if (!rows || !uploadId) return;
    setBusy(true);
    setErr(null);
    try {
      const decisions = rows
        .map((r, i) => {
          const pick = picks[i] ?? (r.sourceValue ? "source" : "org");
          const chosen = pick === "source" ? r.sourceValue : r.orgValue;
          if (!chosen) return null;
          return {
            payerId: r.payerId,
            state: r.state,
            cptCode: r.cptCode,
            attribute: r.attribute,
            coverageStatus: chosen.coverageStatus,
            ruleValue: chosen.ruleValue,
          };
        })
        .filter(Boolean);
      const res = await fetch("/api/rulebook/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId, decisions }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error ?? "Merge failed");
      setMsg(`Merged ${d.data.merged} rows into your rulebook.`);
      setRows(null);
      setUploadId(null);
      onMerged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Path B — upload your existing rulebook</CardTitle>
        <CardDescription>
          CSV with columns: payer, state, cpt, attribute, coverage, value.
          We reconcile it against the Pallio source library so you can
          accept ours or keep yours per row.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          disabled={busy}
          className="block text-sm"
          aria-label="Upload rulebook CSV"
        />
        {msg && (
          <p className="mt-3 text-sm px-3 py-2 rounded bg-emerald-50 text-emerald-800">
            {msg}
          </p>
        )}
        {err && (
          <p role="alert" className="mt-3 text-sm px-3 py-2 rounded bg-red-50 text-red-800">
            {err}
          </p>
        )}

        {rows && rows.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-slate-600">
                {rows.length} cells to reconcile
              </p>
              <Button onClick={applyDecisions} loading={busy}>
                Apply {rows.length} decisions
              </Button>
            </div>
            <div className="overflow-x-auto border border-slate-200 rounded">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left px-2 py-1.5">State</th>
                    <th className="text-left px-2 py-1.5">CPT</th>
                    <th className="text-left px-2 py-1.5">Attribute</th>
                    <th className="text-left px-2 py-1.5">Your upload</th>
                    <th className="text-left px-2 py-1.5">Pallio source</th>
                    <th className="text-left px-2 py-1.5">Use</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={`border-t border-slate-100 ${OUTCOME_STYLE[r.outcome]}`}>
                      <td className="px-2 py-1.5 tabular">{r.state}</td>
                      <td className="px-2 py-1.5 tabular">{r.cptCode}</td>
                      <td className="px-2 py-1.5">{r.attribute}</td>
                      <td className="px-2 py-1.5">
                        {r.orgValue
                          ? `${r.orgValue.coverageStatus}`
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.sourceValue
                          ? `${r.sourceValue.coverageStatus}`
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          value={picks[i] ?? (r.sourceValue ? "source" : "org")}
                          onChange={(e) =>
                            setPicks((p) => ({
                              ...p,
                              [i]: e.target.value as "source" | "org",
                            }))
                          }
                          className="border border-slate-300 rounded px-1 py-0.5 text-xs bg-white"
                        >
                          {r.orgValue && <option value="org">Keep mine</option>}
                          {r.sourceValue && <option value="source">Use Pallio</option>}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
