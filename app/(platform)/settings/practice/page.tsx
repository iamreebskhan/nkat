/**
 * /settings/practice — the practice's time zone and daily visit cap.
 *
 * Both were columns with defaults (America/New_York, 8) and no screen: a
 * practice in Chicago had every evening visit dated by Eastern time, and a
 * team that books ten visits a day hit the scheduler's cap of eight with no
 * way to raise it. See practice-settings.service.ts.
 */
"use client";

import { useEffect, useState } from "react";

import { FieldMarker } from "@/components/forms/field-marker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PRACTICE_TIME_ZONES } from "@/lib/features/org/org-date";
import type { PracticeSettingsView } from "@/lib/features/org/practice-settings.service";

/** How a zone reads to a person: "Eastern — America/New_York". */
const ZONE_NAMES: Record<string, string> = {
  "America/New_York": "Eastern",
  "America/Chicago": "Central",
  "America/Denver": "Mountain",
  "America/Phoenix": "Arizona (no daylight saving)",
  "America/Los_Angeles": "Pacific",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
  "America/Puerto_Rico": "Atlantic (Puerto Rico)",
};

export default function PracticeSettingsPage() {
  const [saved, setSaved] = useState<PracticeSettingsView | null>(null);
  const [timezone, setTimezone] = useState("America/New_York");
  const [capacity, setCapacity] = useState("8");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/settings/practice")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Could not load the practice settings.");
          return;
        }
        const v = d.data as PracticeSettingsView;
        setSaved(v);
        setTimezone(v.timezone);
        setCapacity(String(v.dailyVisitCapacity));
      })
      .catch(() => setError("Network error."));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saved && timezone !== saved.timezone) {
      const ok = window.confirm(
        `Change the practice's time zone to ${ZONE_NAMES[timezone] ?? timezone}? Visits from now on are dated by it. Bills already raised keep their date of service.`,
      );
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/settings/practice", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timezone, dailyVisitCapacity: Number(capacity) }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        return;
      }
      setSaved(data.data as PracticeSettingsView);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      setError("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Practice</h1>
        <p className="text-slate-600 mt-1">
          Where the practice is, and how full a clinician&rsquo;s day can be booked.
        </p>
      </header>

      <Card>
        <CardContent className="p-6">
          <form onSubmit={save} className="space-y-5">
            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">
                Time zone
                <FieldMarker required />
              </span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
              >
                {PRACTICE_TIME_ZONES.map((z) => (
                  <option key={z} value={z}>
                    {ZONE_NAMES[z] ?? z} — {z}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-slate-500 mt-1">
                A visit&rsquo;s date of service is the day it starts in this zone — on bills, reports and
                the schedule&rsquo;s capacity check.
              </span>
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">
                Visits per clinician per day
                <FieldMarker required />
              </span>
              <input
                type="number"
                min={1}
                max={30}
                required
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className="w-32 border border-slate-300 rounded px-3 py-2 text-sm tabular"
              />
              <span className="block text-xs text-slate-500 mt-1">
                Booking or moving a visit past this asks before it goes ahead. Cancelled and no-show
                visits do not count.
              </span>
            </label>

            {error && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
                {error}
              </div>
            )}
            {done && (
              <div role="status" className="text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded">
                Saved.
              </div>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={saving || !saved}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
