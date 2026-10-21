/**
 * /settings/visit-types — the org's own visit types.
 *
 * Client walkthrough [02:30]–[02:32]: "yahan pe visit types mein jo hai — aur
 * agar koi visit type ho raha hai jo hum ne add karna hai."
 *
 * The catch the client couldn't see: the visit type picks the base CPT band.
 * So a custom type has to say which of the known bands it bills as
 * ("Bills like"), and the coder keeps working off that closed set. The org
 * names the encounter however it likes; the billing stays deterministic.
 *
 * Telehealth is a flag on the type, not a band (audit R22): "Telehealth by
 * default" forces the modality on without changing what is coded.
 *
 * "Not billed" is a band too (audit R18), for encounters that are signed and
 * never billed, such as a bereavement follow-up. Each row can be renamed and
 * re-banded in place, so the practice's own list can be entered without the API.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { SELECTABLE_CODING_BASES, type VisitType } from "@/lib/features/visits/visit.types";

interface VisitTypeRow {
  id: string;
  slug: string;
  label: string;
  codingBasis: VisitType;
  /** Every visit of this type is telehealth (audit R22). */
  isTelehealth: boolean;
  active: boolean;
  builtIn: boolean;
  usageCount?: number;
}

// No Telehealth entry: it is a modality, not a band (audit R22). A telehealth
// type bills like new or established and carries the flag below instead.
// Inpatient consult is only shown, on rows that already carry it: nothing can
// code it, so it is no longer offered (audit R18).
const BASIS_LABEL: Record<VisitType, string> = {
  new_patient_home: "New patient — home",
  established_patient_home: "Established patient — home",
  advance_care_planning: "Advance care planning",
  inpatient_consult: "Inpatient consult (not coded)",
  non_billable: "Not billed",
};

export default function VisitTypesSettingsPage() {
  const [rows, setRows] = useState<VisitTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  // Nothing chosen until someone chooses: the band decides the CPT ladder, and
  // a pre-filled one was posted by anyone who typed a name and pressed Add.
  const [codingBasis, setCodingBasis] = useState<VisitType | "">("");
  const [isTelehealth, setIsTelehealth] = useState(false);
  const [adding, setAdding] = useState(false);

  // In-place rename and re-band (audit R18), one row at a time. Both were
  // API-only, so the practice's own list of visit types could not be entered
  // from this screen.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editBasis, setEditBasis] = useState<VisitType>("established_patient_home");

  async function load() {
    try {
      const r = await fetch("/api/settings/visit-types?includeInactive=1");
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not load visit types.");
        return;
      }
      setRows(data.data.types as VisitTypeRow[]);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Started from a timer, as on the audit page, so no setState is reachable
    // synchronously from the effect body (load() sets state after its fetch).
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, []);

  async function add() {
    if (label.trim().length < 2 || codingBasis === "") return;
    setAdding(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/visit-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), codingBasis, isTelehealth }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not add the visit type.");
        return;
      }
      setLabel("");
      setCodingBasis("");
      setIsTelehealth(false);
      await load();
    } catch {
      setError("Network error.");
    } finally {
      setAdding(false);
    }
  }

  async function setActive(id: string, active: boolean) {
    setBusyId(id);
    setError(null);
    try {
      const r = await fetch(`/api/settings/visit-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not update the visit type.");
        return;
      }
      await load();
    } catch {
      setError("Network error.");
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(t: VisitTypeRow) {
    setEditingId(t.id);
    setEditLabel(t.label);
    setEditBasis(t.codingBasis);
    setError(null);
  }

  async function saveEdit(t: VisitTypeRow) {
    const nextLabel = editLabel.trim();
    if (nextLabel.length < 2) return;
    // Only what changed goes out. The PATCH COALESCEs, and an inpatient
    // consult row renamed without re-banding must not re-send a band the
    // server no longer accepts.
    const patch: { label?: string; codingBasis?: VisitType } = {};
    if (nextLabel !== t.label) patch.label = nextLabel;
    if (editBasis !== t.codingBasis) patch.codingBasis = editBasis;
    if (patch.label === undefined && patch.codingBasis === undefined) {
      setEditingId(null);
      return;
    }
    // Re-banding a type in use changes what its unsigned visits code as.
    // Signed visits keep their frozen codes, but once the type is Not billed a
    // signed visit that has no bill yet cannot get one.
    const used = t.usageCount ?? 0;
    if (patch.codingBasis && used > 0) {
      const ok = window.confirm(
        `${used} visit${used === 1 ? " uses" : "s use"} this type; unsigned ones will re-code. Signed visits keep their codes.` +
          (patch.codingBasis === "non_billable"
            ? " Signed visits that have no bill yet will not get one."
            : ""),
      );
      if (!ok) return;
    }
    setBusyId(t.id);
    setError(null);
    try {
      const r = await fetch(`/api/settings/visit-types/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not save the visit type.");
        return;
      }
      setEditingId(null);
      await load();
    } catch {
      setError("Network error.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <Link href="/settings" className="text-xs text-slate-500 hover:underline">
          ← Settings
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">Visit types</h1>
        <p className="text-slate-600 mt-1">
          What appears in the visit-type dropdown when scheduling.
        </p>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Add a visit type</CardTitle>
          <CardDescription>
            Name it whatever your team calls it, then say which visit it bills like.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="font-medium text-slate-700">Name</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Follow-up — assisted living"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-base"
              />
            </label>
            {/* htmlFor, because the InfoTip's <button> comes first in this
                label and would otherwise be the control it names. */}
            <label className="block" htmlFor="new-visit-type-basis">
              <span className="font-medium text-slate-700">Bills like</span>
              <InfoTip label="About Bills like">
                The visit type decides which CPT codes are suggested. A new type
                has to inherit one of the standard encounters so the coding
                stays correct — pick the one it most resembles. Telehealth is
                not an encounter: pick new or established here and tick
                Telehealth by default below. A visit that is never billed, such
                as a bereavement or caregiver-only visit, should use Not billed:
                it is signed and no bill is drafted.
              </InfoTip>
              <select
                id="new-visit-type-basis"
                required
                value={codingBasis}
                onChange={(e) => setCodingBasis(e.target.value as VisitType)}
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-sm"
              >
                <option value="" disabled>Choose what it bills like…</option>
                {SELECTABLE_CODING_BASES.map((t) => (
                  <option key={t} value={t}>
                    {BASIS_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isTelehealth}
              onChange={(e) => setIsTelehealth(e.target.checked)}
            />
            <span className="font-medium text-slate-700">Telehealth by default</span>
            <InfoTip label="About Telehealth by default">
              Every visit of this type is a telehealth visit: scheduling ticks
              Telehealth and it cannot be unticked. That adds the 95/93
              modifier and place of service 10 — it never changes which codes
              are suggested.
            </InfoTip>
          </label>
          <Button
            onClick={add}
            loading={adding}
            disabled={label.trim().length < 2 || codingBasis === ""}
          >
            Add visit type
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your visit types</CardTitle>
          <CardDescription>
            Edit to rename a type or change what it bills like. Deactivate to
            take one out of the dropdown. Past visits keep their type either
            way — nothing is deleted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2">Type</th>
                  <th className="py-2">Bills like</th>
                  <th className="py-2 tabular">Used on</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const editing = editingId === t.id;
                  return (
                    <tr
                      key={t.id}
                      className={`border-b border-slate-100 ${t.active ? "" : "opacity-60"}`}
                    >
                      <td className="py-2 pr-2">
                        {editing ? (
                          <input
                            aria-label="Name"
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            className="h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
                          />
                        ) : (
                          <>
                            <span className="text-slate-800">{t.label}</span>
                            {t.builtIn && (
                              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                                standard
                              </span>
                            )}
                            {t.isTelehealth && (
                              <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-800">
                                telehealth
                              </span>
                            )}
                            {!t.active && (
                              <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                                inactive
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-slate-600">
                        {editing ? (
                          <select
                            aria-label="Bills like"
                            value={editBasis}
                            onChange={(e) => setEditBasis(e.target.value as VisitType)}
                            className="h-8 w-full rounded-md border border-slate-300 px-2 text-sm"
                          >
                            {/* A band no longer offered stays visible on the row
                                that has it, but cannot be chosen (audit R18). */}
                            {!(SELECTABLE_CODING_BASES as readonly VisitType[]).includes(
                              t.codingBasis,
                            ) && (
                              <option value={t.codingBasis} disabled>
                                {BASIS_LABEL[t.codingBasis]}
                              </option>
                            )}
                            {SELECTABLE_CODING_BASES.map((b) => (
                              <option key={b} value={b}>
                                {BASIS_LABEL[b]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          BASIS_LABEL[t.codingBasis]
                        )}
                      </td>
                      <td className="py-2 tabular text-slate-600">
                        {t.usageCount ?? 0} visit{(t.usageCount ?? 0) === 1 ? "" : "s"}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {editing ? (
                          <>
                            <Button
                              variant="ghost"
                              onClick={() => setEditingId(null)}
                              disabled={busyId === t.id}
                            >
                              Cancel
                            </Button>
                            <Button
                              onClick={() => saveEdit(t)}
                              loading={busyId === t.id}
                              disabled={editLabel.trim().length < 2}
                            >
                              Save
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              onClick={() => startEdit(t)}
                              disabled={editingId !== null || busyId === t.id}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => setActive(t.id, !t.active)}
                              loading={busyId === t.id}
                            >
                              {t.active ? "Deactivate" : "Reactivate"}
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
