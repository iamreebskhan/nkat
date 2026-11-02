/**
 * /settings/reason-codes — the practice's discharge and NTUC reasons (0111).
 *
 * Preloaded with the numbering the monthly Trend Report counts them by
 * (discharges 01-10 with 01b/02b, NTUC 20a-27), and editable: Mark Q11a
 * default. A code can be renamed, recounted, retired or brought back, and new
 * ones added; its number cannot change, because past dispositions carry it
 * and the reports match on it. Nothing is deleted.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import type { ReasonCodeView } from "@/lib/features/referrals/reason-code.service";
import {
  REASON_CATEGORIES,
  REASON_CATEGORY_LABEL,
  REASON_CODE_PATTERN,
  type ReasonCategory,
  type ReasonCodeKind,
} from "@/lib/features/referrals/reason-codes";

const KIND_TITLE: Record<ReasonCodeKind, string> = {
  discharge: "Discharge reasons",
  ntuc: "Not taken under care (NTUC)",
};
const KIND_HELP: Record<ReasonCodeKind, string> = {
  discharge: "Why a patient left the service: offered when a patient is discharged.",
  ntuc: "Why a referral was not admitted: offered when a referral is closed as NTUC.",
};

export default function ReasonCodesSettingsPage() {
  const [codes, setCodes] = useState<ReasonCodeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [kind, setKind] = useState<ReasonCodeKind | "">("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<ReasonCategory | "">("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editCategory, setEditCategory] = useState<ReasonCategory>("other");

  async function load() {
    try {
      const r = await fetch("/api/settings/reason-codes?includeRetired=1");
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not load the reason codes.");
        return;
      }
      setCodes(d.data.codes ?? []);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // From a timer, as on the visit-types page, so no setState is reachable
    // synchronously from the effect body.
    const t = setTimeout(() => void load(), 0);
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setCanEdit((d.data?.permissions ?? []).includes("settings.org"));
      })
      .catch(() => {});
    return () => clearTimeout(t);
  }, []);

  const codeOk = REASON_CODE_PATTERN.test(code.trim().toLowerCase());

  async function add() {
    if (!kind || !codeOk || !label.trim() || !category) return;
    setAdding(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/reason-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, code: code.trim().toLowerCase(), label: label.trim(), category }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not add the code.");
        return;
      }
      setCode("");
      setLabel("");
      setCategory("");
      await load();
    } catch {
      setError("Network error.");
    } finally {
      setAdding(false);
    }
  }

  async function patch(c: ReasonCodeView, body: { label?: string; category?: ReasonCategory; active?: boolean }) {
    setBusyId(c.id);
    setError(null);
    try {
      const r = await fetch(`/api/settings/reason-codes/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not save the code.");
        return false;
      }
      await load();
      return true;
    } catch {
      setError("Network error.");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(c: ReasonCodeView) {
    const next = editLabel.trim();
    if (!next) return;
    const body: { label?: string; category?: ReasonCategory } = {};
    if (next !== c.label) body.label = next;
    if (editCategory !== c.category) body.category = editCategory;
    if (Object.keys(body).length === 0) {
      setEditingId(null);
      return;
    }
    if (await patch(c, body)) setEditingId(null);
  }

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <Link href="/settings" className="text-xs text-slate-500 hover:underline">
          ← Settings
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">Reason codes</h1>
        <p className="text-slate-600 mt-1">
          Why a patient was discharged, or a referral not taken under care, numbered as the monthly report counts
          them.
        </p>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {canEdit && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Add a code</CardTitle>
            <CardDescription>
              A new number: two digits and an optional letter, like 21c. The number cannot be changed afterwards.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <label className="block">
                <span className="font-medium text-slate-700">For</span>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ReasonCodeKind)}
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-sm"
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="discharge">Discharge</option>
                  <option value="ntuc">NTUC</option>
                </select>
              </label>
              <label className="block">
                <span className="font-medium text-slate-700">Code</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="21c"
                  maxLength={3}
                  aria-invalid={code !== "" && !codeOk}
                  className={`mt-1 h-9 w-full rounded-md border px-2 font-mono text-base ${
                    code !== "" && !codeOk ? "border-red-600" : "border-slate-300"
                  }`}
                />
              </label>
              <label className="block md:col-span-2">
                <span className="font-medium text-slate-700">Reason</span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={120}
                  placeholder="e.g. To the partner hospice, from the second hospital"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-base"
                />
              </label>
            </div>
            <label className="block md:w-1/2" htmlFor="new-code-category">
              <span className="font-medium text-slate-700">Counts as</span>
              <InfoTip label="About Counts as">
                What the reports count this reason as: a transition to the partner hospice or another one, a death,
                and so on. Two codes can count as the same thing.
              </InfoTip>
              <select
                id="new-code-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as ReasonCategory)}
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-sm"
              >
                <option value="" disabled>
                  Choose…
                </option>
                {REASON_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {REASON_CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            {code !== "" && !codeOk && (
              <p className="text-xs text-red-700">Two digits and an optional letter, like 21c.</p>
            )}
            <Button onClick={add} loading={adding} disabled={!kind || !codeOk || !label.trim() || !category}>
              Add code
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        (["ntuc", "discharge"] as const).map((k) => (
          <Card key={k} className="mb-6">
            <CardHeader>
              <CardTitle>{KIND_TITLE[k]}</CardTitle>
              <CardDescription>{KIND_HELP[k]}</CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm" aria-label={KIND_TITLE[k]}>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 w-16">Code</th>
                    <th className="py-2">Reason</th>
                    <th className="py-2">Counts as</th>
                    {canEdit && <th className="py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {codes
                    .filter((c) => c.kind === k)
                    // By number, as the report lists them: a 21c added later
                    // sits with 21a and 21b.
                    .sort((a, b) => a.code.localeCompare(b.code))
                    .map((c) => {
                      const editing = editingId === c.id;
                      return (
                        <tr key={c.id} className={`border-b border-slate-100 ${c.active ? "" : "opacity-60"}`}>
                          <td className="py-2 pr-2 font-mono">{c.code}</td>
                          <td className="py-2 pr-2">
                            {editing ? (
                              <input
                                aria-label="Reason"
                                value={editLabel}
                                maxLength={120}
                                onChange={(e) => setEditLabel(e.target.value)}
                                className="h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
                              />
                            ) : (
                              <>
                                <span className="text-slate-800">{c.label}</span>
                                {!c.active && (
                                  <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                                    retired
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <td className="py-2 pr-2 text-slate-600">
                            {editing ? (
                              <select
                                aria-label="Counts as"
                                value={editCategory}
                                onChange={(e) => setEditCategory(e.target.value as ReasonCategory)}
                                className="h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
                              >
                                {REASON_CATEGORIES.map((cat) => (
                                  <option key={cat} value={cat}>
                                    {REASON_CATEGORY_LABEL[cat]}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              REASON_CATEGORY_LABEL[c.category]
                            )}
                          </td>
                          {canEdit && (
                            <td className="py-2 text-right whitespace-nowrap">
                              {editing ? (
                                <>
                                  <Button variant="ghost" onClick={() => setEditingId(null)} disabled={busyId === c.id}>
                                    Cancel
                                  </Button>
                                  <Button onClick={() => saveEdit(c)} loading={busyId === c.id} disabled={!editLabel.trim()}>
                                    Save
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button
                                    variant="ghost"
                                    disabled={editingId !== null || busyId === c.id}
                                    onClick={() => {
                                      setEditingId(c.id);
                                      setEditLabel(c.label);
                                      setEditCategory(c.category);
                                      setError(null);
                                    }}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    loading={busyId === c.id}
                                    onClick={() => void patch(c, { active: !c.active })}
                                  >
                                    {c.active ? "Retire" : "Bring back"}
                                  </Button>
                                </>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
