/**
 * "What did we actually provide on this visit?"
 *
 * Client walkthrough [02:36–02:47]: against a visit, record the different
 * services — what help was given, what was handed over.
 *
 * The visit TYPE says what kind of encounter it was; this says what happened
 * in the room. Ticking a box records it; the optional minutes box is there
 * because time-based codes care about how long a specific service took.
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
import type {
  ProvidedServiceView,
  ServiceCategory,
  VisitServiceView,
} from "@/lib/features/visits/visit-services.service";

const CATEGORY_LABEL: Record<ServiceCategory, string> = {
  clinical: "Clinical",
  psychosocial: "Psychosocial",
  care_coordination: "Care coordination",
  education: "Education",
  other: "Other",
};

type Selection = { checked: boolean; minutes: string };

export function VisitServicesPanel({ visitId }: { visitId: string }) {
  const [catalog, setCatalog] = useState<VisitServiceView[]>([]);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const [cRes, pRes] = await Promise.all([
          fetch("/api/settings/visit-services").then((r) => r.json()),
          fetch(`/api/visits/${visitId}/services`).then((r) => r.json()),
        ]);
        if (abandoned) return;
        if (cRes?.success) setCatalog(cRes.data.services as VisitServiceView[]);
        if (pRes?.success) {
          const next: Record<string, Selection> = {};
          for (const p of pRes.data.services as ProvidedServiceView[]) {
            next[p.serviceId] = {
              checked: true,
              minutes: p.minutes === null ? "" : String(p.minutes),
            };
          }
          setSelected(next);
        }
      } catch {
        if (!abandoned) setError("Could not load services.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [visitId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const services = Object.entries(selected)
        .filter(([, s]) => s.checked)
        .map(([serviceId, s]) => ({
          serviceId,
          minutes: s.minutes.trim() === "" ? null : Number(s.minutes),
        }));
      const r = await fetch(`/api/visits/${visitId}/services`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ services }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Could not save.");
        return;
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const cur = prev[id] ?? { checked: false, minutes: "" };
      return { ...prev, [id]: { ...cur, checked: !cur.checked } };
    });
  }

  const grouped = groupByCategory(catalog);
  const chosen = Object.values(selected).filter((s) => s.checked).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Services provided</CardTitle>
        <CardDescription>
          What was actually done on this visit. The visit type sets the base
          code; this records the care.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading ? (
          <p className="text-slate-500">Loading…</p>
        ) : catalog.length === 0 ? (
          <p className="text-slate-600">
            No services in your catalog yet. An administrator can add them under{" "}
            <a href="/settings" className="text-[var(--color-brand-700)] underline">
              Settings → Visit services
            </a>
            .
          </p>
        ) : (
          <>
            {grouped.map(([category, items]) => (
              <fieldset key={category} className="space-y-1.5">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {CATEGORY_LABEL[category]}
                </legend>
                {items.map((s) => {
                  const sel = selected[s.id];
                  const on = sel?.checked ?? false;
                  return (
                    <div key={s.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        id={`svc-${s.id}`}
                        checked={on}
                        onChange={() => toggle(s.id)}
                        className="mt-1"
                      />
                      <label htmlFor={`svc-${s.id}`} className="flex-1 cursor-pointer">
                        <span className="text-slate-800">{s.name}</span>
                        {s.cptHint && (
                          <span
                            className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
                            title="Commonly supports this code — the suggester still decides what's billed"
                          >
                            {s.cptHint}
                          </span>
                        )}
                        {s.description && (
                          <span className="block text-xs text-slate-500">{s.description}</span>
                        )}
                      </label>
                      {on && (
                        <input
                          type="number"
                          min={0}
                          max={720}
                          value={sel?.minutes ?? ""}
                          onChange={(e) =>
                            setSelected((prev) => ({
                              ...prev,
                              [s.id]: { checked: true, minutes: e.target.value },
                            }))
                          }
                          placeholder="min"
                          aria-label={`Minutes spent on ${s.name}`}
                          className="h-8 w-16 rounded-md border border-slate-300 px-2 text-xs tabular"
                        />
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}

            {error && (
              <p role="alert" className="rounded bg-red-50 px-2 py-2 text-xs text-red-700">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3 pt-1">
              <Button variant="secondary" onClick={save} loading={saving}>
                Save services
              </Button>
              <span className="text-xs text-slate-500" aria-live="polite">
                {chosen} selected{savedAt ? ` · saved ${savedAt}` : ""}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function groupByCategory(
  items: VisitServiceView[],
): [ServiceCategory, VisitServiceView[]][] {
  const order: ServiceCategory[] = [
    "clinical",
    "psychosocial",
    "care_coordination",
    "education",
    "other",
  ];
  const map = new Map<ServiceCategory, VisitServiceView[]>();
  for (const i of items) {
    const list = map.get(i.category) ?? [];
    list.push(i);
    map.set(i.category, list);
  }
  return order
    .filter((c) => map.has(c))
    .map((c) => [c, map.get(c)!] as [ServiceCategory, VisitServiceView[]]);
}
