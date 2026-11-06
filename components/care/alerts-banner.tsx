/**
 * Escalation alerts waiting on the chart (0116; Level-1 doc:55-57): what
 * crossed the care plan's limits, where it came from, and the NP's two moves,
 * acknowledging it or giving a task from it.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { alertText, type EscalationAlertView } from "@/lib/features/care-coordination/care-coordination.types";
import { ESCALATION_MEASURE_INFO } from "@/lib/features/care-plans/care-plan.types";
import { usePracticeTime } from "@/lib/features/schedule/use-practice-zone";

import { TaskForm } from "./tasks";

const SOURCE_LABEL: Record<EscalationAlertView["source"], string> = {
  vitals: "visit vitals",
  phone: "a phone call",
  event: "an event on the Course tab",
};

export function AlertsBanner({
  patientId,
  me,
  canAcknowledge,
  canGiveTask,
  version,
  onChanged,
}: {
  patientId: string;
  me: string | null;
  /** careplans.edit */
  canAcknowledge: boolean;
  /** patients.edit */
  canGiveTask: boolean;
  /** Bumped by the chart when something that can raise an alert was saved. */
  version: number;
  onChanged: () => void;
}) {
  const [alerts, setAlerts] = useState<EscalationAlertView[]>([]);
  const [own, setOwn] = useState(0);
  const [acking, setAcking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [tasking, setTasking] = useState<EscalationAlertView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // The open alerts could not be read. The banner used to stay away, which on a
  // chart reads as "nothing is waiting".
  const [loadFailed, setLoadFailed] = useState(false);
  // Raised on the practice's clock.
  const atPractice = usePracticeTime();

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients/${patientId}/alerts?status=open`)
      .then(async (r) => ({ status: r.status, d: await r.json() }))
      .then(({ status, d }) => {
        if (abandoned) return;
        if (d.success) {
          setAlerts(d.data.rows);
          setLoadFailed(false);
          // A refusal is not a failure: alerts are shown to whoever may read them.
        } else setLoadFailed(status !== 403);
      })
      .catch(() => {
        if (!abandoned) setLoadFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [patientId, version, own]);

  async function acknowledge(id: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/alerts/${id}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
      });
      const d = await r.json();
      if (!d.success) return setMsg(d.error ?? "Not saved.");
      setAcking(null);
      setNote("");
      setOwn((v) => v + 1);
      onChanged();
    } catch {
      setMsg("Network error — not saved.");
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed && alerts.length === 0) {
    return (
      <p role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
        This patient&apos;s escalation alerts could not be loaded, so any that are open are not shown. Reload the page
        to try again.
      </p>
    );
  }
  if (alerts.length === 0) return null;
  return (
    <div role="region" aria-label="Escalation alerts" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950">
      <p className="font-medium">
        {alerts.length === 1 ? "An escalation alert is waiting" : `${alerts.length} escalation alerts are waiting`}
      </p>
      <ul className="mt-2 space-y-2">
        {alerts.map((a) => (
          <li key={a.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span>
                <strong>{alertText(a, ESCALATION_MEASURE_INFO)}</strong>
                <span className="text-red-900/80">
                  {" "}
                  · from {SOURCE_LABEL[a.source]}
                  {a.visitId && (
                    <>
                      {" "}
                      (
                      <Link href={`/visits/${a.visitId}/document`} className="underline">
                        open
                      </Link>
                      )
                    </>
                  )}{" "}
                  · {atPractice(a.raisedAt)}
                  {a.notifiedName ? ` · ${a.notifiedName} was told` : " · no primary NP to tell"}
                </span>
              </span>
              {acking !== a.id && tasking?.id !== a.id && (
                <span className="flex gap-3">
                  {canGiveTask && (
                    <button type="button" className="text-xs font-medium underline" onClick={() => setTasking(a)}>
                      Give a task
                    </button>
                  )}
                  {canAcknowledge && (
                    <button
                      type="button"
                      className="text-xs font-medium underline"
                      onClick={() => {
                        setAcking(a.id);
                        setNote("");
                        setMsg(null);
                      }}
                    >
                      Acknowledge
                    </button>
                  )}
                </span>
              )}
            </div>
            {acking === a.id && (
              <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="Acknowledge alert">
                <TextInput
                  aria-label="What you did about it"
                  placeholder="What you did about it (optional)"
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="h-8 min-w-48 flex-1 bg-white text-sm"
                />
                <Button type="button" variant="secondary" size="sm" onClick={() => setAcking(null)}>
                  Back
                </Button>
                <Button type="button" size="sm" loading={busy} onClick={() => void acknowledge(a.id)}>
                  Acknowledge
                </Button>
              </div>
            )}
            {tasking?.id === a.id && (
              <div className="mt-2 rounded-md bg-white text-slate-900">
                <TaskForm
                  patientId={patientId}
                  alertId={a.id}
                  today={null}
                  defaults={{ title: `Follow up: ${alertText(a, ESCALATION_MEASURE_INFO)}`, discipline: "np", assigneeUserId: me ?? undefined }}
                  onCancel={() => setTasking(null)}
                  onSaved={() => {
                    setTasking(null);
                    onChanged();
                  }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {msg && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {msg}
        </p>
      )}
    </div>
  );
}
