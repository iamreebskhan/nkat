/**
 * /patients/[id] — patient record overview.
 *
 * Source: pallio_complete_vision_v3 §6.2 (patient record).
 *
 * Tabs (light-weight, no router state for now):
 *   - Overview: demographics + insurance + clinical
 *   - Visits: list with link to documentation
 *   - Care plan: link to /patients/[id]/care-plan
 *   - Billing: superbill summary (per-visit count + status mix)
 */
"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PatientView } from "@/lib/features/patients/patient.types";
import type { VisitView } from "@/lib/features/visits/visit.types";

type Tab = "overview" | "visits" | "billing" | "care-plan";

export default function PatientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [patient, setPatient] = useState<PatientView | null>(null);
  const [visits, setVisits] = useState<VisitView[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const [pRes, vRes] = await Promise.all([
          fetch(`/api/patients/${id}`),
          fetch(`/api/visits?patientId=${id}&limit=50`),
        ]);
        const p = await pRes.json();
        const v = await vRes.json();
        if (abandoned) return;
        if (!p.success) {
          setError(p.error ?? "Patient not found.");
          return;
        }
        setPatient(p.data);
        if (v.success) setVisits(v.data.rows ?? []);
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

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;
  if (error || !patient)
    return (
      <div className="px-8 py-8">
        <p className="text-red-700">{error ?? "Patient not found."}</p>
        <Link
          href="/patients"
          className="mt-4 inline-block text-[var(--color-brand-700)] underline"
        >
          ← Back to patients
        </Link>
      </div>
    );

  const fullName = `${patient.firstName} ${patient.lastName}`;

  return (
    <div className="px-8 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <Link href="/patients" className="text-xs text-slate-500 hover:underline">
            ← Patients
          </Link>
          <h1 className="font-display text-3xl tracking-tight mt-1">
            {fullName}
          </h1>
          <p className="text-slate-600 mt-1 tabular">
            DOB {patient.dateOfBirth} · {patient.status}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/patients/${id}/care-plan`}>
            <Button variant="secondary">Care plan</Button>
          </Link>
          <Link href={`/schedule?patientId=${id}`}>
            <Button>Schedule visit</Button>
          </Link>
        </div>
      </header>

      <div className="border-b border-slate-200 mb-6 flex gap-1">
        {(["overview", "visits", "billing", "care-plan"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-[var(--color-brand-600)] text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.replace("-", " ")}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-slate-700">
              <Row label="Name" value={fullName} />
              <Row label="DOB" value={patient.dateOfBirth} mono />
              <Row label="Sex assigned at birth" value={patient.sexAssignedAtBirth ?? "—"} />
              <Row label="Phone" value={patient.phone ?? "—"} mono />
              <Row label="Address" value={patient.addressLine1 ?? "—"} />
              <Row label="City / State / ZIP" value={`${patient.city ?? "—"}, ${patient.state ?? "—"} ${patient.zip ?? ""}`} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Insurance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-slate-700">
              <Row label="Primary payer ID" value={patient.primaryPayerId ?? "—"} mono />
              <Row label="Member ID" value={patient.primaryMemberId ?? "—"} mono />
            </CardContent>
          </Card>
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Clinical</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-slate-700">
              <Row label="Primary diagnosis (ICD-10)" value={patient.primaryDiagnosisIcd10 ?? "—"} mono />
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "visits" && (
        <Card>
          <CardHeader>
            <CardTitle>Visits</CardTitle>
            <CardDescription>{visits.length} visit{visits.length === 1 ? "" : "s"} on file</CardDescription>
          </CardHeader>
          <CardContent>
            {visits.length === 0 ? (
              <p className="text-sm text-slate-500">No visits yet. Schedule one above.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {visits.map((v) => (
                  <li key={v.id} className="py-2 flex items-center justify-between text-sm">
                    <div>
                      <span className="font-medium">{v.visitType.replace(/_/g, " ")}</span>
                      <span className="text-slate-500 tabular">
                        {" · "}
                        {(v.startTime ?? v.scheduledStart ?? v.createdAt).slice(0, 10)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 capitalize">{v.status.replace(/_/g, " ")}</span>
                      <Link
                        href={`/visits/${v.id}/document`}
                        className="text-xs text-[var(--color-brand-700)] hover:underline"
                      >
                        Open →
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "billing" && (
        <Card>
          <CardHeader>
            <CardTitle>Billing summary</CardTitle>
            <CardDescription>Real billing data wires up in Phase 4.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-500">
              Superbill list, paid vs denied breakdown, and refile workflow lands
              when the visit→superbill→submission pipeline is wired in Phase 4.
            </p>
          </CardContent>
        </Card>
      )}

      {tab === "care-plan" && (
        <Card>
          <CardHeader>
            <CardTitle>Care plan</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              href={`/patients/${id}/care-plan`}
              className="text-[var(--color-brand-700)] underline"
            >
              Open care plan →
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={mono ? "font-mono tabular text-xs" : ""}>{value}</span>
    </div>
  );
}
