/**
 * This visit and the later ones of its repeating series (0126). One occurrence
 * is cancelled or moved the ordinary way; these two change the rest with it.
 */
"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { orgInstant, orgLocalInput } from "@/lib/features/org/org-date";
import { usePracticeZone } from "@/lib/features/schedule/use-practice-zone";
import type { SeriesConflict } from "@/lib/features/visits/visit-series";

export function SeriesActions({
  visitId,
  scheduledStart,
  onCancelled,
  onMoved,
}: {
  visitId: string;
  scheduledStart: string;
  onCancelled: () => void;
  onMoved: (start: string) => void;
}) {
  const zone = usePracticeZone();
  const [moving, setMoving] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SeriesConflict[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const post = (body: object) =>
    fetch(`/api/visits/${visitId}/series`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  async function cancelRest() {
    if (!window.confirm("Cancel this visit and every later visit in the series? They stay on the record as cancelled, and free their places in the day.")) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await post({ action: "cancel" });
      if (!d.success) return setMsg(d.error ?? "They could not be cancelled.");
      onCancelled();
    } catch {
      setMsg("Network error. Reload the page to see which visits were cancelled.");
    } finally {
      setBusy(false);
    }
  }

  async function moveRest(confirmDoubleBook = false) {
    if (!moving || !zone) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await post({ action: "move", startLocal: moving, ...(confirmDoubleBook ? { confirmDoubleBook: true } : {}) });
      if (!d.success) return setMsg(d.error ?? "They could not be moved.");
      if (d.data.conflicts.length > 0) return setConflicts(d.data.conflicts);
      setMoving(null);
      setConflicts(null);
      setMsg(`Moved ${d.data.moved.length} ${d.data.moved.length === 1 ? "visit" : "visits"}.`);
      onMoved(orgInstant(moving, zone.timeZone).toISOString());
    } catch {
      setMsg("Network error. Reload the page to see which visits were moved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 text-sm">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" loading={busy && !moving} onClick={() => void cancelRest()}>
          Cancel this and later visits
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!zone}
          onClick={() => {
            setConflicts(null);
            setMoving(moving === null && zone ? orgLocalInput(scheduledStart, zone.timeZone) : null);
          }}
        >
          Move this and later visits
        </Button>
      </div>
      {moving !== null && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block text-xs font-medium text-slate-700">
            New date and time for this visit ({zone?.zoneName})
            <input
              type="datetime-local"
              value={moving}
              onChange={(e) => {
                setConflicts(null);
                setMoving(e.target.value);
              }}
              className="mt-1 block border border-slate-300 rounded px-3 py-1.5 text-sm"
            />
          </label>
          <Button size="sm" loading={busy} onClick={() => void moveRest()}>
            Move them
          </Button>
          <p className="basis-full text-xs text-slate-600">The later visits move by the same number of days, to the same time.</p>
        </div>
      )}
      {conflicts && (
        <div role="alert" className="mt-2 rounded bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-inset ring-amber-600/30">
          <p className="font-medium">{conflicts.length === 1 ? "One day needs a look." : `${conflicts.length} days need a look.`} Nothing has moved yet.</p>
          <ul className="mt-1 list-disc pl-5">
            {conflicts.map((c) => (
              <li key={c.day}>
                {c.day}: {c.detail}
              </li>
            ))}
          </ul>
          <Button className="mt-2" variant="secondary" size="sm" disabled={busy} onClick={() => void moveRest(true)}>
            Move them anyway
          </Button>
        </div>
      )}
      {msg && (
        <p role="status" className="mt-2 text-slate-700">
          {msg}
        </p>
      )}
    </div>
  );
}
