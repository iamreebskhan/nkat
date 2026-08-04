/**
 * Create Bill — raise a superbill from the billing side.
 *
 * Client walkthrough [03:48–04:28]:
 *   "is mein humare paas client selection add hoga… kaun se appointment ke
 *    against yeh bill ban raha hai. Jaise hum client select karein to us ki
 *    jitni bhi visits schedule hui, us ka drop-down humare paas aa jaye…
 *    phir us ka fee jo bhi hoga woh, aur status."
 *
 * Pick the client → pick which appointment the bill is against → the fee comes
 * from the visit's coded charges automatically → status is shown. The bill
 * itself is built by the same server path the visit page uses, so the codes,
 * fee and payer rules stay identical no matter where it was raised from.
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/forms/field";

interface PatientOption {
  id: string;
  firstName: string;
  lastName: string;
  primaryPayerId: string | null;
}

interface BillableVisit {
  visitId: string;
  visitType: string;
  status: string;
  dateOfService: string | null;
  clinicianName: string | null;
  superbillId: string | null;
  superbillStatus: string | null;
  billedAmountCents: number | null;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function CreateBillDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [patientId, setPatientId] = useState("");
  const [visits, setVisits] = useState<BillableVisit[] | null>(null);
  const [visitId, setVisitId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/patients?limit=200")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setPatients(d.data?.rows ?? []);
      })
      .catch(() => undefined);
  }, []);

  // Client picked → load that client's appointments.
  useEffect(() => {
    if (!patientId) {
      setVisits(null);
      setVisitId("");
      return;
    }
    setVisits(null);
    fetch(`/api/billing/billable-visits?patientId=${patientId}`)
      .then((r) => r.json())
      .then((d) => setVisits(d.success ? (d.data?.rows ?? []) : []))
      .catch(() => setVisits([]));
  }, [patientId]);

  const selected = visits?.find((v) => v.visitId === visitId) ?? null;

  async function submit() {
    if (!selected) return;
    // Already billed → just open it rather than creating a duplicate.
    if (selected.superbillId) {
      router.push(`/visits/${selected.visitId}/superbill`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/visits/${selected.visitId}/superbill`, { method: "POST" });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not create the bill.");
        return;
      }
      onCreated();
      router.push(`/visits/${selected.visitId}/superbill`);
    } catch {
      setError("Network error — the bill was not created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/40 flex items-start justify-center p-6 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Create bill"
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mt-16">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-display text-xl tracking-tight">Create bill</h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-800 text-sm">
            Close
          </button>
        </div>

        <div className="p-6 space-y-4">
          <Field id="cb-patient" label="Client" required hint="Who the bill is for.">
            <Select id="cb-patient" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
              <option value="">Select…</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.firstName} {p.lastName}
                  {p.primaryPayerId ? "" : "  (no payer on file)"}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="cb-visit"
            label="Appointment"
            required
            hint="Which visit this bill is against."
          >
            <Select
              id="cb-visit"
              value={visitId}
              onChange={(e) => setVisitId(e.target.value)}
              disabled={!patientId || visits === null}
            >
              <option value="">
                {!patientId
                  ? "Pick a client first…"
                  : visits === null
                    ? "Loading appointments…"
                    : visits.length === 0
                      ? "No visits on file for this client"
                      : "Select…"}
              </option>
              {(visits ?? []).map((v) => (
                <option key={v.visitId} value={v.visitId}>
                  {(v.dateOfService ?? "").slice(0, 10)} · {v.visitType.replace(/_/g, " ")}
                  {v.clinicianName ? ` · ${v.clinicianName}` : ""}
                  {v.superbillId ? ` · already billed (${v.superbillStatus})` : ""}
                </option>
              ))}
            </Select>
          </Field>

          {selected && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Fee</span>
                <span className="tabular font-semibold">
                  {selected.billedAmountCents !== null
                    ? money(selected.billedAmountCents)
                    : "Calculated from the visit's coded charges"}
                </span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-slate-600">Status</span>
                <span className="capitalize">
                  {selected.superbillStatus ?? "will be created as draft"}
                </span>
              </div>
              {selected.superbillId && (
                <p className="mt-2 text-xs text-amber-800">
                  This appointment already has a bill — continuing opens it instead of
                  creating a second one.
                </p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 rounded px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!selected || busy} loading={busy}>
            {selected?.superbillId ? "Open bill" : "Create bill"}
          </Button>
        </div>
      </div>
    </div>
  );
}
