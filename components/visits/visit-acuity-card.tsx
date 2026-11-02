/**
 * The acuity the NP gives at this visit (0115, Mark Q9 default): kept apart
 * from the triage's, it becomes the patient's current acuity and joins the
 * history on the chart's Course tab. Given while the visit is open; a signed
 * visit shows what was given.
 */
"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PATIENT_ACUITIES, PATIENT_ACUITY_LABEL, type PatientAcuity } from "@/lib/features/patients/patient.types";

export function VisitAcuityCard({
  visitId,
  open,
  canEdit,
  patientAcuity,
}: {
  visitId: string;
  /** Scheduled or in progress: the server takes it only then. */
  open: boolean;
  /** patient.acuity.edit, as the route requires. */
  canEdit: boolean;
  /** The patient's acuity before this visit, for the prompt. */
  patientAcuity: PatientAcuity | null;
}) {
  // undefined while loading; null when none was given at this visit.
  const [given, setGiven] = useState<PatientAcuity | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/visits/${visitId}/acuity`)
      .then((r) => r.json())
      .then((d) => {
        if (!abandoned) setGiven(d.success ? (d.data.acuity ?? null) : null);
      })
      .catch(() => {
        if (!abandoned) setGiven(null);
      });
    return () => {
      abandoned = true;
    };
  }, [visitId]);

  async function give(next: PatientAcuity) {
    const prev = given ?? null;
    setGiven(next);
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/visits/${visitId}/acuity`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acuity: next }),
      });
      const d = await r.json();
      if (!d.success) {
        setGiven(prev);
        setMsg(d.error ?? "Not saved.");
      }
    } catch {
      setGiven(prev);
      setMsg("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  const editable = open && canEdit;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Acuity at this visit</CardTitle>
        <CardDescription>
          Your judgement today, kept apart from the triage&rsquo;s. It becomes the patient&rsquo;s acuity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {given === undefined ? (
          <p className="text-slate-500">Loading…</p>
        ) : editable ? (
          <label className="block">
            <span className="sr-only">Acuity at this visit</span>
            <select
              value={given ?? ""}
              disabled={saving}
              onChange={(e) => e.target.value && void give(e.target.value as PatientAcuity)}
              className="w-full h-9 px-2 border border-slate-300 rounded-md text-sm bg-white"
            >
              <option value="" disabled>
                {patientAcuity ? `Not given yet (was ${PATIENT_ACUITY_LABEL[patientAcuity]})` : "Not given yet"}
              </option>
              {PATIENT_ACUITIES.map((a) => (
                <option key={a} value={a}>
                  {PATIENT_ACUITY_LABEL[a]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="font-medium text-slate-800">{given ? PATIENT_ACUITY_LABEL[given] : "None given at this visit"}</p>
        )}
        {msg && (
          <p role="alert" className="text-xs text-red-700">
            {msg}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
