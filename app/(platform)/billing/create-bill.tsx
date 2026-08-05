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
  patientId: string;
  name: string;
  dob: string | null;
  status: string;
  payerName: string | null;
  billableVisits: number;
  unbilledVisits: number;
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
  // Server-computed preview of what the bill will come out at.
  const [preview, setPreview] = useState<{
    billedAmountCents: number;
    warnings: string[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Clients with something to bill — not the patient list, which defaults to
  // active and so hid discharged and deceased clients whose claims are still
  // being filed.
  useEffect(() => {
    fetch("/api/billing/billable-clients")
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

  // Appointment picked → preview the fee. Uses the same GET the visit page
  // uses, so the number shown is the number persistDraft will write rather
  // than a second, drifting calculation in the browser.
  useEffect(() => {
    setPreview(null);
    const v = visits?.find((x) => x.visitId === visitId);
    if (!visitId || !v || v.superbillId) {
      // Must clear the flag here too. A re-run that bails (visit deselected,
      // or `visits` refetched so the id no longer resolves) used to leave
      // previewLoading stuck true from the previous run, and the Fee row read
      // "Calculating…" forever even though the request had already returned.
      setPreviewLoading(false);
      return;
    }
    let abandoned = false;
    setPreviewLoading(true);
    fetch(`/api/visits/${visitId}/superbill`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned || !d.success || !d.data?.draft) return;
        setPreview({
          billedAmountCents: d.data.draft.billedAmountCents ?? 0,
          warnings: d.data.draft.warnings ?? [],
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!abandoned) setPreviewLoading(false);
      });
    return () => {
      abandoned = true;
    };
  }, [visitId, visits]);

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
                <option key={p.patientId} value={p.patientId}>
                  {p.name}
                  {/* DOB disambiguates same-named patients — two "John Smith"s
                      are ordinary, and billing the wrong one is a real error. */}
                  {p.dob ? ` · DOB ${p.dob}` : ""}
                  {p.status !== "active" ? ` · ${p.status}` : ""}
                  {p.unbilledVisits > 0 ? ` · ${p.unbilledVisits} unbilled` : ""}
                  {p.payerName ? "" : " · no payer on file"}
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
                {/* Client walkthrough [04:16]–[04:22]: "automatically … visit ke
                    against dikha de, ke us ki fee yeh hai." For a new bill the
                    amount used to be a sentence, not a number — the preview
                    comes from the same server path that will persist it, so
                    what's shown is what gets raised. */}
                <span className="tabular font-semibold">
                  {selected.billedAmountCents !== null
                    ? money(selected.billedAmountCents)
                    : previewLoading
                      ? "Calculating…"
                      : preview
                        ? preview.billedAmountCents > 0
                          ? `${money(preview.billedAmountCents)} (estimated)`
                          : "$0.00 — no rated CPT codes on this visit"
                        : "Calculated from the visit's coded charges"}
                </span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-slate-600">Status</span>
                <span className="capitalize">
                  {selected.superbillStatus ?? "will be created as draft"}
                </span>
              </div>
              {/* Warnings the superbill page shows after creation — surface
                  them here so a $0 or uncoded bill is caught before it's
                  raised, not after. */}
              {!selected.superbillId && (preview?.warnings?.length ?? 0) > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-amber-800">
                  {preview!.warnings.map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              )}
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
