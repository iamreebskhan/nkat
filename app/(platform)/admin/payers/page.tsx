/**
 * /admin/payers — the payer roster every org bills against (audit R17).
 *
 * The roster used to change only through a seed file and a deploy. A client
 * in a fourth state, or one billing a plan we had not listed, could not pick
 * the patient's payer at intake, and a retired plan could not be withdrawn
 * from the pickers.
 *
 * Add a payer when a client names one, never on spec: a listed payer with no
 * rules is a pick that answers "unknown" for every org. The amber counts show
 * where that is already true (Aetna is listed for NC and SC and has no live
 * rules in either). After a save, register the payer's policy source or have
 * an analyst attest its rules.
 *
 * Platform-admin only — the API checks session.role === 'platform_admin'.
 */
"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { Field, Select, TextInput } from "@/components/forms/field";
import { FieldMarker } from "@/components/forms/field-marker";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  PAYER_TYPE_LABELS,
  PAYER_TYPES,
  type PayerType,
} from "@/lib/features/billing/payer-types";
import {
  defaultProlongedServiceCode,
  prolongedServiceCodeFor,
  type ProlongedServiceCode,
} from "@/lib/features/billing/prolonged-code";
import { US_STATES } from "@/lib/reference/us-states";

interface PayerRow {
  id: string;
  name: string;
  parentOrg: string | null;
  payerType: PayerType;
  statesServed: string[];
  policyIndexUrl: string | null;
  /** The prolonged-service code its record names (0108); null = by type. */
  prolongedServiceCode: ProlongedServiceCode | null;
  active: boolean;
  /** Live payer_rule rows per state. */
  liveRules: Record<string, number>;
}

interface Draft {
  /** null while adding. */
  id: string | null;
  name: string;
  parentOrg: string;
  payerType: PayerType;
  states: string[];
  policyIndexUrl: string;
  /** "" = by payer type. */
  prolongedCode: ProlongedServiceCode | "";
}

const NEW_DRAFT: Draft = {
  id: null,
  name: "",
  parentOrg: "",
  payerType: "commercial",
  states: [],
  policyIndexUrl: "",
  prolongedCode: "",
};

const sameStates = (a: string[], b: string[]) =>
  [...a].sort().join() === [...b].sort().join();

/** Only the fields that changed, so the audit row names what was edited. */
function editPatch(d: Draft, was: PayerRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const parentOrg = d.parentOrg.trim() || null;
  const policyIndexUrl = d.policyIndexUrl.trim() || null;
  if (d.name.trim() !== was.name) patch.name = d.name;
  if (parentOrg !== was.parentOrg) patch.parentOrg = parentOrg;
  if (d.payerType !== was.payerType) patch.payerType = d.payerType;
  if (!sameStates(d.states, was.statesServed)) patch.statesServed = d.states;
  if (policyIndexUrl !== was.policyIndexUrl) patch.policyIndexUrl = policyIndexUrl;
  if ((d.prolongedCode || null) !== was.prolongedServiceCode) patch.prolongedServiceCode = d.prolongedCode || null;
  return patch;
}

const ALERT =
  "px-3 py-2 rounded-md bg-red-50 ring-1 ring-inset ring-red-600/20 text-sm text-red-800";

export default function PayerRosterPage() {
  const [rows, setRows] = useState<PayerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Bumped after every save; the effect below re-reads the roster on change.
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  /** Name of the payer just saved, for the "now register its source" prompt. */
  const [savedName, setSavedName] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});

  // From a timer, as on the ingestion-sources page, so no setState runs
  // synchronously in the effect body.
  useEffect(() => {
    let gone = false;
    const t = setTimeout(async () => {
      setLoading(true);
      setLoadErr(null);
      try {
        const r = await fetch("/api/admin/payers", { cache: "no-store" });
        const d = await r.json();
        if (gone) return;
        if (!d.success) setLoadErr(d.error ?? "Failed to load.");
        else setRows(d.data.rows);
      } catch {
        if (!gone) setLoadErr("Network error.");
      } finally {
        if (!gone) setLoading(false);
      }
    }, 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [reloadKey]);

  function openDraft(next: Draft) {
    setDraft(next);
    setFormErr(null);
    setSavedName(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleState(s: string) {
    setDraft((d) =>
      d && {
        ...d,
        states: d.states.includes(s) ? d.states.filter((x) => x !== s) : [...d.states, s],
      },
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    if (draft.states.length === 0) {
      setFormErr("Pick at least one state the payer serves.");
      return;
    }
    const was = draft.id ? rows.find((r) => r.id === draft.id) : undefined;
    const body = was
      ? editPatch(draft, was)
      : {
          name: draft.name,
          parentOrg: draft.parentOrg.trim() || undefined,
          payerType: draft.payerType,
          statesServed: draft.states,
          policyIndexUrl: draft.policyIndexUrl.trim() || undefined,
          prolongedServiceCode: draft.prolongedCode || undefined,
        };
    if (was && Object.keys(body).length === 0) {
      setFormErr("Nothing changed.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    setSavedName(null);
    try {
      const r = await fetch(was ? `/api/admin/payers/${was.id}` : "/api/admin/payers", {
        method: was ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.success) {
        setFormErr(d.error ?? "Save failed.");
        return;
      }
      setSavedName(d.data.name);
      setDraft(null);
      setReloadKey((k) => k + 1);
    } catch {
      setFormErr("Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function setActive(row: PayerRow, active: boolean) {
    if (
      !active &&
      !window.confirm(
        `Withdraw ${row.name} from every org's payer pickers? Charts and claims that already name it keep it, and you can reactivate it here.`,
      )
    ) {
      return;
    }
    setBusy((b) => ({ ...b, [row.id]: true }));
    setRowErr((m) => ({ ...m, [row.id]: "" }));
    try {
      const r = await fetch(`/api/admin/payers/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const d = await r.json();
      if (!d.success) {
        setRowErr((m) => ({ ...m, [row.id]: d.error ?? "Failed." }));
        return;
      }
      setReloadKey((k) => k + 1);
    } catch {
      setRowErr((m) => ({ ...m, [row.id]: "Network error." }));
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

  const active = rows.filter((r) => r.active);
  const withdrawn = rows.length - active.length;
  const gaps = active.reduce(
    (n, r) => n + r.statesServed.filter((s) => !r.liveRules[s]).length,
    0,
  );

  return (
    <div className="px-8 py-8 max-w-6xl">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Payers</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-3xl">
            The roster every org picks from at intake, in the rule lookup and on
            the attestation form. Add a payer when a client names one. Until its
            policy source is ingested or an analyst attests its rules, lookups
            for it fall back to benchmarks.
          </p>
        </div>
        {!draft && <Button onClick={() => openDraft(NEW_DRAFT)}>+ Add payer</Button>}
      </header>

      {savedName && (
        <p className="mb-4 px-3 py-2 rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-600/20 text-sm text-emerald-800">
          Saved &ldquo;{savedName}&rdquo;. Next, register its policy source on{" "}
          <Link href="/admin/ingestion-sources" className="underline font-medium">
            Ingestion sources
          </Link>{" "}
          so its rules can be extracted, or have an analyst attest them.
        </p>
      )}
      {loadErr && (
        <p role="alert" className={`mb-4 ${ALERT}`}>
          {loadErr}
        </p>
      )}

      {draft && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{draft.id ? "Edit payer" : "Add payer"}</CardTitle>
            <CardDescription>
              The roster is global: every org can pick this payer as soon as it
              is saved. Intake accepts it only in the states ticked here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field id="payer-name" label="Name" required>
                  <TextInput
                    id="payer-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    required
                    minLength={2}
                    maxLength={150}
                  />
                </Field>
                <Field
                  id="payer-parent"
                  label="Parent organization"
                  optional
                  explain="The carrier behind the plan, e.g. Centene for Buckeye Health Plan."
                >
                  <TextInput
                    id="payer-parent"
                    value={draft.parentOrg}
                    onChange={(e) => setDraft({ ...draft, parentOrg: e.target.value })}
                    maxLength={120}
                  />
                </Field>
                <Field
                  id="payer-type"
                  label="Type"
                  required
                  explain="Decides the product line its rules are read under: a Medicare Advantage plan is looked up as medicare_advantage, not commercial."
                >
                  <Select
                    id="payer-type"
                    value={draft.payerType}
                    onChange={(e) => setDraft({ ...draft, payerType: e.target.value as PayerType })}
                  >
                    {PAYER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {PAYER_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  id="payer-prolonged"
                  label="Prolonged-service code"
                  explain="The add-on suggested for home visit time past the top code. G0318 counts from the CMS total time, 99417 from the CPT time. Change it only where the payer has said which it takes, e.g. an Ohio Medicaid plan that follows CMS and takes G0318."
                >
                  <Select
                    id="payer-prolonged"
                    value={draft.prolongedCode}
                    onChange={(e) =>
                      setDraft({ ...draft, prolongedCode: e.target.value as ProlongedServiceCode | "" })
                    }
                  >
                    <option value="">By payer type ({defaultProlongedServiceCode(draft.payerType)})</option>
                    <option value="G0318">G0318 (CMS prolonged home visit)</option>
                    <option value="99417">99417 (CPT prolonged service)</option>
                  </Select>
                </Field>
                <Field id="payer-url" label="Policy library URL" optional>
                  <TextInput
                    id="payer-url"
                    type="url"
                    value={draft.policyIndexUrl}
                    onChange={(e) => setDraft({ ...draft, policyIndexUrl: e.target.value })}
                    placeholder="https://"
                  />
                </Field>
              </div>
              <fieldset>
                <legend className="text-sm font-medium text-slate-700 mb-2">
                  States served
                  <FieldMarker required />
                </legend>
                <div className="grid grid-cols-6 sm:grid-cols-9 gap-1.5">
                  {US_STATES.map((s) => {
                    const sel = draft.states.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={sel}
                        onClick={() => toggleState(s)}
                        className={`h-9 rounded-md text-sm font-mono tabular border transition-colors ${
                          sel
                            ? "bg-[var(--color-brand-600)] text-white border-[var(--color-brand-700)]"
                            : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              {formErr && (
                <p role="alert" className={ALERT}>
                  {formErr}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving}>
                  {draft.id ? "Save changes" : "Add payer"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Roster ({active.length} active{withdrawn > 0 ? `, ${withdrawn} withdrawn` : ""})
          </CardTitle>
          <CardDescription>
            Each state shows its live rule count.{" "}
            <span className="text-amber-800 font-medium">Amber</span> marks a state
            the payer is listed for with no live rules ({gaps} today): intake
            accepts the pair and shows a note that lookups will fall back to
            benchmarks.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="px-4 py-6 text-sm text-slate-500">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">No payers on the roster.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-semibold px-4 py-2">Name</th>
                    <th className="text-left font-semibold px-4 py-2">Type</th>
                    <th className="text-left font-semibold px-4 py-2">States · live rules</th>
                    <th className="text-right font-semibold px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} className={r.active ? "" : "bg-slate-50"}>
                      <td className="px-4 py-2 align-top">
                        <div className={`font-medium ${r.active ? "text-slate-900" : "text-slate-500"}`}>
                          {r.name}
                          {!r.active && (
                            <span className="ml-2 text-[11px] font-normal uppercase tracking-wide text-slate-500">
                              withdrawn
                            </span>
                          )}
                        </div>
                        {r.parentOrg && <div className="text-[11px] text-slate-500">{r.parentOrg}</div>}
                      </td>
                      <td className="px-4 py-2 align-top text-xs text-slate-700">
                        {PAYER_TYPE_LABELS[r.payerType] ?? r.payerType}
                        <div className="text-[11px] text-slate-500">
                          Prolonged: {prolongedServiceCodeFor(r.payerType, r.prolongedServiceCode)}
                          {r.prolongedServiceCode ? " (set for this payer)" : " (by type)"}
                        </div>
                      </td>
                      <td className="px-4 py-2 align-top">
                        <div className="flex flex-wrap gap-1">
                          {r.statesServed.map((s) => {
                            const n = r.liveRules[s] ?? 0;
                            return (
                              <span
                                key={s}
                                title={
                                  n === 0
                                    ? `${s}: no live rules. Lookups for ${r.name} here fall back to benchmarks.`
                                    : `${s}: ${n} live rule${n === 1 ? "" : "s"}`
                                }
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-mono tabular ring-1 ring-inset ${
                                  n === 0
                                    ? "bg-amber-50 text-amber-800 ring-amber-600/30"
                                    : "bg-slate-50 text-slate-700 ring-slate-200"
                                }`}
                              >
                                {s}
                                <span className={n === 0 ? "font-semibold" : "text-slate-500"}>{n}</span>
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-2 align-top text-right whitespace-nowrap">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              openDraft({
                                id: r.id,
                                name: r.name,
                                parentOrg: r.parentOrg ?? "",
                                payerType: r.payerType,
                                states: r.statesServed,
                                policyIndexUrl: r.policyIndexUrl ?? "",
                                prolongedCode: r.prolongedServiceCode ?? "",
                              })
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant={r.active ? "ghost" : "secondary"}
                            loading={busy[r.id]}
                            onClick={() => void setActive(r, !r.active)}
                          >
                            {r.active ? "Deactivate" : "Reactivate"}
                          </Button>
                        </div>
                        {rowErr[r.id] && (
                          <p role="alert" className="mt-1 text-xs text-red-700 whitespace-normal">
                            {rowErr[r.id]}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
