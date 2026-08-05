/**
 * /settings/visit-services — manage the catalog of services a clinician can
 * record against a visit.
 *
 * Client walkthrough [02:30–02:47]: "agar koi visit type ho raha hai jo hum ne
 * add karna hai… agar kuch different types [ki] services hongi ke is visit
 * mein hum logon ne kya kya un ko help provide karni [hai]."
 *
 * Note on visit TYPES: those stay a fixed list, because the type selects the
 * base CPT code. An arbitrary new type would change what gets billed, so the
 * extensibility lives here instead — in what was provided, not in how the
 * encounter is coded.
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
import type {
  ServiceCategory,
  VisitServiceView,
} from "@/lib/features/visits/visit-services.service";

const CATEGORIES: { value: ServiceCategory; label: string }[] = [
  { value: "clinical", label: "Clinical" },
  { value: "psychosocial", label: "Psychosocial" },
  { value: "care_coordination", label: "Care coordination" },
  { value: "education", label: "Education" },
  { value: "other", label: "Other" },
];

export default function VisitServicesSettingsPage() {
  const [services, setServices] = useState<VisitServiceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<ServiceCategory>("clinical");
  const [cptHint, setCptHint] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/settings/visit-services?includeInactive=1");
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not load the catalog.");
        return;
      }
      setServices(data.data.services as VisitServiceView[]);
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
    if (name.trim().length < 2) return;
    setAdding(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/visit-services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          category,
          cptHint: cptHint.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not add the service.");
        return;
      }
      setName("");
      setDescription("");
      setCptHint("");
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
      const r = await fetch(`/api/settings/visit-services/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not update the service.");
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
        <h1 className="font-display text-3xl tracking-tight mt-1">Visit services</h1>
        <p className="text-slate-600 mt-1">
          What a clinician can record as provided on a visit. Visit types stay
          fixed — they choose the billing code.
        </p>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Add a service</CardTitle>
          <CardDescription>Appears in the picker on the document screen.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="font-medium text-slate-700">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Bereavement support"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-base"
              />
            </label>
            <label className="block">
              <span className="font-medium text-slate-700">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ServiceCategory)}
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="font-medium text-slate-700">
              Description <span className="text-slate-400">(optional)</span>
            </span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line explaining when to use it"
              className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-base"
            />
          </label>
          <label className="block max-w-xs">
            <span className="font-medium text-slate-700">
              CPT hint <span className="text-slate-400">(optional)</span>
            </span>
            <InfoTip label="About the CPT hint">
              Shown next to the service as a reminder. It does not change what
              is billed — the code suggester and your payer rules still decide
              that.
            </InfoTip>
            <input
              value={cptHint}
              onChange={(e) => setCptHint(e.target.value)}
              placeholder="99497"
              className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-base font-mono tabular"
            />
          </label>
          <Button onClick={add} loading={adding} disabled={name.trim().length < 2}>
            Add service
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Catalog</CardTitle>
          <CardDescription>
            Deactivate to remove a service from the picker. Past visits keep
            their record either way — nothing is deleted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : services.length === 0 ? (
            <p className="text-sm text-slate-600">Nothing in the catalog yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2">Service</th>
                  <th className="py-2">Category</th>
                  <th className="py-2 tabular">Used on</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr
                    key={s.id}
                    className={`border-b border-slate-100 ${s.active ? "" : "opacity-60"}`}
                  >
                    <td className="py-2">
                      <span className="text-slate-800">{s.name}</span>
                      {s.cptHint && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                          {s.cptHint}
                        </span>
                      )}
                      {!s.active && (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                          inactive
                        </span>
                      )}
                      {s.description && (
                        <span className="block text-xs text-slate-500">{s.description}</span>
                      )}
                    </td>
                    <td className="py-2 text-slate-600">
                      {CATEGORIES.find((c) => c.value === s.category)?.label ?? s.category}
                    </td>
                    <td className="py-2 tabular text-slate-600">
                      {s.usageCount ?? 0} visit{(s.usageCount ?? 0) === 1 ? "" : "s"}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        onClick={() => setActive(s.id, !s.active)}
                        loading={busyId === s.id}
                      >
                        {s.active ? "Deactivate" : "Reactivate"}
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
