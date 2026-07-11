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
import { ThreadPanel } from "@/components/messaging/thread-panel";

type Tab = "overview" | "visits" | "billing" | "care-plan" | "messages";

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
  // Self user id (messaging panel) + role (care-team editing is org_admin-only).
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [isOrgAdmin, setIsOrgAdmin] = useState(false);
  // Org roster for the care-team selects — fetched only for org_admin
  // (other roles lack team.view and get the read-only names instead).
  const [roster, setRoster] = useState<{ userId: string; fullName: string | null; email: string }[]>([]);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data?.userId) setSelfUserId(d.data.userId);
        if (d.success && d.data?.role === "org_admin") {
          setIsOrgAdmin(true);
          return fetch("/api/team/members")
            .then((r) => r.json())
            .then((m) => {
              if (m.success) setRoster(m.data?.rows ?? []);
            });
        }
      })
      .catch(() => {});
  }, []);

  async function assignSeat(field: string, userId: string | null, seat: "primaryNp" | "rn" | "socialWorker" | "billingAgent") {
    if (!patient) return;
    const prevSeat = patient.careTeam[seat];
    const member = roster.find((m) => m.userId === userId);
    // Functional updates: only touch the one seat, so a concurrent change to
    // any other field (e.g. acuity) is never clobbered by optimism/rollback.
    const applySeat = (value: typeof prevSeat) =>
      setPatient((p) => (p ? { ...p, careTeam: { ...p.careTeam, [seat]: value } } : p));
    applySeat({ userId, name: member ? (member.fullName ?? member.email) : null });
    try {
      const r = await fetch(`/api/patients/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ careTeam: { [field]: userId } }),
      });
      const d = await r.json();
      if (!d.success) {
        applySeat(prevSeat);
        alert(d.error ?? "Failed to update care team.");
      }
    } catch {
      applySeat(prevSeat);
      alert("Network error — care team not saved.");
    }
  }

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
          <ExportRecordButton patientId={id} />
          <Link href={`/patients/${id}/care-plan`}>
            <Button variant="secondary">Care plan</Button>
          </Link>
          <Link href={`/schedule?patientId=${id}`}>
            <Button>Schedule visit</Button>
          </Link>
        </div>
      </header>

      <div className="border-b border-slate-200 mb-6 flex gap-1">
        {(["overview", "visits", "billing", "care-plan", "messages"] as const).map((t) => (
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
            <CardContent className="space-y-2 text-sm text-slate-700">
              <Row label="Primary diagnosis (ICD-10)" value={patient.primaryDiagnosisIcd10 ?? "—"} mono />
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Acuity</span>
                <select
                  value={patient.acuity ?? ""}
                  aria-label="Patient acuity"
                  className="h-8 px-2 rounded-md border border-slate-300 bg-white text-sm"
                  onChange={async (e) => {
                    const next = e.target.value;
                    if (!next) return; // acuity can't be cleared back to unassigned
                    const prev = patient.acuity;
                    setPatient({ ...patient, acuity: next as PatientView["acuity"] });
                    const r = await fetch(`/api/patients/${id}`, {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ clinical: { acuity: next } }),
                    });
                    const d = await r.json();
                    if (!d.success) {
                      setPatient({ ...patient, acuity: prev });
                      alert(d.error ?? "Failed to update acuity.");
                    }
                  }}
                >
                  <option value="">— unassigned —</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </CardContent>
          </Card>
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Care team</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm text-slate-700">
              {([
                ["Primary NP", "primaryNpUserId", "primaryNp"],
                ["RN", "rnUserId", "rn"],
                ["Social worker", "socialWorkerUserId", "socialWorker"],
                ["Billing agent", "billingAgentUserId", "billingAgent"],
              ] as const).map(([label, field, seat]) => (
                <div key={field} className="flex items-center justify-between gap-3">
                  <span className="text-slate-500">{label}</span>
                  {isOrgAdmin ? (
                    <select
                      value={patient.careTeam[seat].userId ?? ""}
                      aria-label={`Assign ${label}`}
                      className="h-8 px-2 rounded-md border border-slate-300 bg-white text-sm max-w-56"
                      onChange={(e) => void assignSeat(field, e.target.value || null, seat)}
                    >
                      <option value="">— unassigned —</option>
                      {roster.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.fullName ?? m.email}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{patient.careTeam[seat].name ?? "—"}</span>
                  )}
                </div>
              ))}
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

      {tab === "billing" && <BillingTab patientId={id} />}

      {tab === "messages" && (
        <div>
          {selfUserId ? (
            <ThreadPanel patientId={id} selfUserId={selfUserId} />
          ) : (
            <p className="text-slate-500 text-sm">Loading messages…</p>
          )}
        </div>
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

/**
 * HIPAA right-of-access export — fetches the patient record PDF from
 * /api/patients/[id]/export and triggers a browser download. The
 * server-side route writes a phi_export_log row.
 */
function ExportRecordButton({ patientId }: { patientId: string }) {
  const [downloading, setDownloading] = useState(false);
  async function download() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/patients/${patientId}/export`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `patient-${patientId}-record.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }
  return (
    <Button
      variant="secondary"
      onClick={download}
      loading={downloading}
      title="Patient's HIPAA right-of-access export. Logged to phi_export_log."
    >
      Download record
    </Button>
  );
}

interface SuperbillRow {
  id: string;
  status: string;
  dateOfService: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
}

function BillingTab({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<SuperbillRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/superbills?limit=200`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned || !d.success) return;
        // Filter client-side to this patient — list endpoint doesn't yet
        // take patientId. Add when needed at scale.
        setRows((d.data?.rows ?? []).filter((r: SuperbillRow & { patientId?: string }) =>
          r.patientId === patientId,
        ));
      })
      .finally(() => {
        if (!abandoned) setLoading(false);
      });
    return () => { abandoned = true; };
  }, [patientId]);

  const billed = rows.reduce((s, r) => s + r.billedAmountCents, 0);
  const paid = rows.reduce((s, r) => s + (r.paidAmountCents ?? 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing summary</CardTitle>
        <CardDescription>
          {loading
            ? "Loading…"
            : rows.length === 0
              ? "No superbills yet — generate one from a documented visit."
              : `${rows.length} superbill${rows.length === 1 ? "" : "s"} · $${(billed / 100).toFixed(2)} billed · $${(paid / 100).toFixed(2)} paid`}
        </CardDescription>
      </CardHeader>
      {rows.length > 0 && (
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-semibold px-4 py-2.5">DOS</th>
                <th className="text-left font-semibold px-4 py-2.5">Status</th>
                <th className="text-right font-semibold px-4 py-2.5">Billed</th>
                <th className="text-right font-semibold px-4 py-2.5">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 tabular text-slate-700">{r.dateOfService.slice(0, 10)}</td>
                  <td className="px-4 py-2 text-xs">{r.status.replace("_", " ")}</td>
                  <td className="px-4 py-2 text-right tabular">${(r.billedAmountCents / 100).toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular">
                    {r.paidAmountCents == null ? "—" : `$${(r.paidAmountCents / 100).toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      )}
    </Card>
  );
}
