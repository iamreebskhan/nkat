/**
 * /settings/visit-types — the org's own visit types.
 *
 * Client walkthrough [02:30]–[02:32]: "yahan pe visit types mein jo hai — aur
 * agar koi visit type ho raha hai jo hum ne add karna hai."
 *
 * The catch the client couldn't see: the visit type picks the base CPT band.
 * So a custom type has to say which of the five known bands it bills as
 * ("Bills like"), and the coder keeps working off that closed set. The org
 * names the encounter however it likes; the billing stays deterministic.
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
import { VISIT_TYPES, type VisitType } from "@/lib/features/visits/visit.types";

interface VisitTypeRow {
  id: string;
  slug: string;
  label: string;
  codingBasis: VisitType;
  active: boolean;
  builtIn: boolean;
  usageCount?: number;
}

const BASIS_LABEL: Record<VisitType, string> = {
  new_patient_home: "New patient — home",
  established_patient_home: "Established patient — home",
  advance_care_planning: "Advance care planning",
  telehealth: "Telehealth",
  inpatient_consult: "Inpatient consult",
};

export default function VisitTypesSettingsPage() {
  const [rows, setRows] = useState<VisitTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [codingBasis, setCodingBasis] = useState<VisitType>("established_patient_home");
  const [adding, setAdding] = useState(false);

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
    void load();
  }, []);

  async function add() {
    if (label.trim().length < 2) return;
    setAdding(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/visit-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), codingBasis }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not add the visit type.");
        return;
      }
      setLabel("");
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
                placeholder="e.g. Bereavement follow-up"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-base"
              />
            </label>
            <label className="block">
              <span className="font-medium text-slate-700">Bills like</span>
              <InfoTip label="About Bills like">
                The visit type decides which CPT codes are suggested. A new type
                has to inherit one of the five standard encounters so the coding
                stays correct — pick the one it most resembles.
              </InfoTip>
              <select
                value={codingBasis}
                onChange={(e) => setCodingBasis(e.target.value as VisitType)}
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-sm"
              >
                {VISIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {BASIS_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button onClick={add} loading={adding} disabled={label.trim().length < 2}>
            Add visit type
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your visit types</CardTitle>
          <CardDescription>
            Deactivate to take one out of the dropdown. Past visits keep their
            type either way — nothing is deleted.
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
                {rows.map((t) => (
                  <tr
                    key={t.id}
                    className={`border-b border-slate-100 ${t.active ? "" : "opacity-60"}`}
                  >
                    <td className="py-2">
                      <span className="text-slate-800">{t.label}</span>
                      {t.builtIn && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                          standard
                        </span>
                      )}
                      {!t.active && (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                          inactive
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-slate-600">{BASIS_LABEL[t.codingBasis]}</td>
                    <td className="py-2 tabular text-slate-600">
                      {t.usageCount ?? 0} visit{(t.usageCount ?? 0) === 1 ? "" : "s"}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        onClick={() => setActive(t.id, !t.active)}
                        loading={busyId === t.id}
                      >
                        {t.active ? "Deactivate" : "Reactivate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
