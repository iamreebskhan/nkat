/**
 * /visits/[id]/superbill — review + persist + export.
 *
 * Source: pallio_complete_vision_v3 §6.5 / §8.3.
 *
 * On load we fetch the existing superbill (or a fresh in-memory draft).
 * The billing agent reviews, edits if needed, persists with POST, then
 * downloads the PDF.
 */
"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import { CodePicker } from "@/components/billing/code-picker";
import { RuleSidebar } from "@/components/billing/rule-sidebar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PatientView } from "@/lib/features/patients/patient.types";

interface SuperbillDraft {
  visitId: string;
  patientId: string;
  payerId: string | null;
  memberIdSnapshot: string;
  dateOfService: string;
  cptCodes: string[];
  icd10Codes: string[];
  modifiers: string[];
  providerNpi: string;
  providerName: string;
  placeOfServiceCode: string;
  billedAmountCents: number;
  ratedCodes: { code: string; rateCents: number }[];
  unratedCodes: string[];
  warnings: string[];
}

export default function SuperbillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [draft, setDraft] = useState<SuperbillDraft | null>(null);
  const [persistedId, setPersistedId] = useState<string | null>(null);
  const [patient, setPatient] = useState<PatientView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local edits applied to the draft; flushed to the server via
  // PATCH (after first save) or POST (when saving for the first time).
  const [edits, setEdits] = useState<{
    cpt?: string[];
    icd10?: string[];
    modifiers?: string[];
    pendingOverrides?: Array<{ code: string; reason: string }>;
  }>({});

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch(`/api/visits/${id}/superbill`);
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setError(data.error ?? "Failed to load superbill.");
          return;
        }
        if (data.data.existing) {
          setPersistedId(data.data.existing.id);
          // The persisted row doesn't carry the per-code rate breakdown
          // or warnings — show what we have. The FE could re-build the
          // draft on demand if desired (POST returns the draft fields).
          setDraft({
            visitId: data.data.existing.visitId,
            patientId: data.data.existing.patientId,
            payerId: data.data.existing.payerId,
            memberIdSnapshot: data.data.existing.memberIdSnapshot,
            dateOfService: data.data.existing.dateOfService,
            cptCodes: data.data.existing.cptCodes,
            icd10Codes: data.data.existing.icd10Codes,
            modifiers: data.data.existing.modifiers,
            providerNpi: data.data.existing.providerNpi,
            providerName: data.data.existing.providerName,
            placeOfServiceCode: data.data.existing.placeOfServiceCode,
            billedAmountCents: data.data.existing.billedAmountCents,
            ratedCodes: [],
            unratedCodes: [],
            warnings: [],
          });
        } else {
          setDraft(data.data.draft);
        }
        // Fetch patient for rule-check sidebar (need state).
        const patientId = data.data.existing?.patientId ?? data.data.draft?.patientId;
        if (patientId) {
          try {
            const pr = await fetch(`/api/patients/${patientId}`);
            const pd = await pr.json();
            if (pd.success && !abandoned) setPatient(pd.data as PatientView);
          } catch {
            /* sidebar shows hint */
          }
        }
      } catch {
        if (!abandoned) setError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [id]);

  async function persist() {
    setSaving(true);
    setError(null);
    try {
      // First save: POST creates the row from the visit's persisted
      // codes. Then we PATCH any edits the nurse made in the picker.
      let id1 = persistedId;
      if (!id1) {
        const r = await fetch(`/api/visits/${id}/superbill`, { method: "POST" });
        const data = await r.json();
        if (!data.success) {
          setError(data.error ?? "Persist failed.");
          return;
        }
        id1 = data.data.id;
        setPersistedId(id1);
        if (data.data.draft) setDraft(data.data.draft);
      }

      const hasEdits =
        edits.cpt !== undefined ||
        edits.icd10 !== undefined ||
        edits.modifiers !== undefined ||
        (edits.pendingOverrides && edits.pendingOverrides.length > 0);
      if (hasEdits && id1) {
        const pr = await fetch(`/api/superbills/${id1}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            patch: {
              ...(edits.cpt && { cptCodes: edits.cpt }),
              ...(edits.icd10 && { icd10Codes: edits.icd10 }),
              ...(edits.modifiers && { modifiers: edits.modifiers }),
            },
            overrides: edits.pendingOverrides ?? [],
          }),
        });
        const pdata = await pr.json();
        if (!pdata.success) {
          setError(pdata.error ?? "Edits failed to save.");
          return;
        }
        // Reflect the saved state locally and clear pending overrides.
        setDraft((d) =>
          d
            ? {
                ...d,
                cptCodes: edits.cpt ?? d.cptCodes,
                icd10Codes: edits.icd10 ?? d.icd10Codes,
                modifiers: edits.modifiers ?? d.modifiers,
              }
            : d,
        );
        setEdits({});
      }
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  // The picker reads from `cptCodes` on the draft + any local edits.
  const currentCpts = edits.cpt ?? draft?.cptCodes ?? [];

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;
  if (error || !draft)
    return (
      <div className="px-8 py-8">
        <p className="text-red-700">{error ?? "Could not build superbill."}</p>
      </div>
    );

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <Link
          href={`/visits/${id}/document`}
          className="text-xs text-slate-500 hover:underline"
        >
          ← Visit documentation
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">Superbill</h1>
        <p className="text-slate-600 mt-1 tabular text-sm">
          DOS {draft.dateOfService} · POS {draft.placeOfServiceCode} ·{" "}
          {persistedId ? "saved" : "draft (in-memory)"}
        </p>
      </header>

      {draft.warnings.length > 0 && (
        <Card severity="warn" className="mb-4">
          <CardHeader>
            <CardTitle>Verify before submission</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc pl-5 text-sm text-amber-900 space-y-1">
              {draft.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Patient &amp; provider</CardTitle>
          <CardDescription>
            Auto-populated from the visit + patient records.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-slate-700">
          <Row label="Patient ID" value={draft.patientId} mono />
          <Row label="Payer ID" value={draft.payerId ?? "—"} mono />
          <Row label="Member ID" value={draft.memberIdSnapshot || "—"} mono />
          <Row label="Provider" value={`${draft.providerName} (NPI ${draft.providerNpi || "—"})`} />
          <Row label="Place of service" value={draft.placeOfServiceCode} mono />
          <Row
            label="Billed"
            value={`$${(draft.billedAmountCents / 100).toFixed(2)}`}
            mono
          />
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Billable codes</CardTitle>
          <CardDescription>
            Pick from codes the patient&rsquo;s payer covers in their state. Off-allowlist
            picks require a one-line reason and are recorded in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodePicker
            payerId={patient?.primaryPayerId ?? draft.payerId}
            state={patient?.state ?? null}
            selected={currentCpts}
            onChange={(cpt) => setEdits((e) => ({ ...e, cpt }))}
            onOverride={(o) =>
              setEdits((e) => ({
                ...e,
                pendingOverrides: [...(e.pendingOverrides ?? []), o],
              }))
            }
          />
          <hr className="my-4 border-slate-100" />
          <label className="block text-xs text-slate-500 font-medium">
            ICD-10 diagnoses (comma-separated)
            <input
              type="text"
              defaultValue={draft.icd10Codes.join(", ")}
              onBlur={(e) =>
                setEdits((eds) => ({
                  ...eds,
                  icd10: e.target.value
                    .split(",")
                    .map((s) => s.trim().toUpperCase())
                    .filter(Boolean),
                }))
              }
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </label>
          <label className="block mt-3 text-xs text-slate-500 font-medium">
            Modifiers (comma-separated)
            <input
              type="text"
              defaultValue={draft.modifiers.join(", ")}
              onBlur={(e) =>
                setEdits((eds) => ({
                  ...eds,
                  modifiers: e.target.value
                    .split(",")
                    .map((s) => s.trim().toUpperCase())
                    .filter(Boolean),
                }))
              }
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </label>
          {edits.pendingOverrides && edits.pendingOverrides.length > 0 && (
            <p className="mt-3 text-xs text-amber-800">
              {edits.pendingOverrides.length} off-allowlist override
              {edits.pendingOverrides.length === 1 ? "" : "s"} queued — will be
              audit-logged on save.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Pre-submission rule check</CardTitle>
          <CardDescription>
            Per-CPT coverage status from the patient&rsquo;s primary payer.
            Resolve any red rows before marking ready-to-submit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RuleSidebar
            payerId={patient?.primaryPayerId ?? draft.payerId}
            state={patient?.state}
            cptCodes={currentCpts}
            attribute="covered"
          />
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={persist} loading={saving}>
          {persistedId ? "Re-save" : "Save superbill"}
        </Button>
        <Button
          variant="secondary"
          disabled={!persistedId || exporting}
          onClick={async () => {
            if (!persistedId) return;
            setExporting(true);
            try {
              const res = await fetch(`/api/superbills/${persistedId}/pdf`);
              if (!res.ok) {
                const data = await res.json().catch(() => null);
                alert(data?.error ?? `Export failed (${res.status})`);
                return;
              }
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `superbill-${persistedId}.pdf`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "Generating…" : "Export PDF"}
        </Button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={mono ? "font-mono tabular text-xs" : ""}>{value}</span>
    </div>
  );
}
