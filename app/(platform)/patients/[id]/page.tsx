/**
 * /patients/[id] — patient record overview.
 *
 * Source: pallio_complete_vision_v3 §6.2 (patient record).
 *
 * Tabs (light-weight, no router state for now):
 *   - Overview: demographics + insurance + clinical + consents, each editable
 *     in place (components/patients/patient-record-cards.tsx)
 *   - Course: the care episode and discharge, acuity history, hospice
 *     eligibility, falls / ED visits / admissions (components/patients/clinical-course.tsx)
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
import { visitsOnFile } from "@/lib/features/visits/visits-on-file";
import { AlertsBanner } from "@/components/care/alerts-banner";
import { CallsTab } from "@/components/care/calls";
import { PatientTasks } from "@/components/care/tasks";
import { ThreadPanel } from "@/components/messaging/thread-panel";
import { ClinicalCourseTab } from "@/components/patients/clinical-course";
import { ClinicalListsCards } from "@/components/patients/clinical-lists";
import { DocumentsCard } from "@/components/patients/documents-card";
import { ExternalProvidersCard } from "@/components/patients/external-providers-card";
import { PriorAuthsCard } from "@/components/patients/prior-auths-card";
import { PatientContactsCard } from "@/components/patients/patient-contacts-card";
import {
  ClinicalCard,
  ConsentsCard,
  IdentityCard,
  InsuranceCard,
} from "@/components/patients/patient-record-cards";
import { VitalsTrend } from "@/components/patients/vitals-trend";

const TABS = ["overview", "course", "calls", "tasks", "visits", "vitals", "billing", "care-plan", "messages"] as const;
type Tab = (typeof TABS)[number];

export default function PatientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = use(params);
  // ?tab=messages opens on a tab: where a mention in the bell leads.
  const askedParam = use(searchParams).tab;
  const asked = typeof askedParam === "string" ? askedParam : undefined;
  const [patient, setPatient] = useState<PatientView | null>(null);
  const [visits, setVisits] = useState<VisitView[]>([]);
  /**
   * Every visit this patient has, which is not always how many are listed
   * below: the fetch asks for the newest 200, the API's maximum. What lets the
   * tab say "Latest 200 of 206" rather than "200 visits on file" (audit R34).
   */
  const [visitTotal, setVisitTotal] = useState(0);
  /** Visits on this chart that are not this reader's to list (app/api/visits/route.ts). */
  const [visitsWithheld, setVisitsWithheld] = useState(0);
  const [tab, setTab] = useState<Tab>(() =>
    TABS.includes(asked as Tab) ? (asked as Tab) : "overview",
  );
  // A bell link to the chart already open is a navigation that keeps this
  // page mounted, so the tab follows it here, during render. Keyed on the
  // navigation (each brings a new searchParams), not on the value: the tab
  // buttons below move the URL with history.replaceState, which Next leaves
  // out of these props, so the value alone could not tell a link to
  // ?tab=messages from the page it was already on.
  const [seenParams, setSeenParams] = useState(searchParams);
  if (searchParams !== seenParams) {
    setSeenParams(searchParams);
    if (TABS.includes(asked as Tab)) setTab(asked as Tab);
  }
  function showTab(t: Tab) {
    setTab(t);
    // The URL names the tab, so a reload or a copied link opens on it.
    window.history.replaceState(window.history.state, "", `?tab=${t}`);
  }
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Self user id (messaging panel) + care-team edit capability. Gated on the
  // patients.careteam.edit PERMISSION (roles are display-only) — mirrors the
  // server-side gate exactly.
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [canEditCareTeam, setCanEditCareTeam] = useState(false);
  // Family, caregivers and outside providers (audit R30) gate on
  // patients.edit, exactly as their API routes do.
  const [canEditPatient, setCanEditPatient] = useState(false);
  // Hospice eligibility, like acuity, is a clinical judgement.
  const [canJudgeAcuity, setCanJudgeAcuity] = useState(false);
  // Between visits (0116): a call is clinical documentation (visits.create;
  // voiding one, visits.edit); an escalation alert is acknowledged by whoever
  // keeps the care plan (careplans.edit).
  const [canRecordCalls, setCanRecordCalls] = useState(false);
  const [canVoidCalls, setCanVoidCalls] = useState(false);
  const [canAckAlerts, setCanAckAlerts] = useState(false);
  // A PCM/CCM month's charge goes to billing as a signed visit does
  // (visits.submit), and links to its bill for whoever may open one (0117).
  const [canRaiseCharge, setCanRaiseCharge] = useState(false);
  const [canViewBill, setCanViewBill] = useState(false);
  // A prior authorization (0124) is recorded by whoever edits the chart or the bill.
  const [canEditAuths, setCanEditAuths] = useState(false);
  // Re-read the alerts banner after anything that can raise one is saved.
  const [alertsVersion, setAlertsVersion] = useState(0);
  const bumpAlerts = () => setAlertsVersion((v) => v + 1);
  // Opens any visit's documentation; without it a colleague's visit opens
  // read-only (visit-access.ts mayReadVisit).
  const [canSeeAllVisits, setCanSeeAllVisits] = useState(false);
  // ACTIVE org roster for the care-team selects — ?active=1 keeps the picker
  // consistent with what the patient service will accept (suspended/removed
  // members are rejected with a 422).
  const [roster, setRoster] = useState<{ userId: string; fullName: string | null; email: string }[]>([]);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data?.userId) setSelfUserId(d.data.userId);
        if (d.success) setCanEditPatient((d.data?.permissions ?? []).includes("patients.edit"));
        if (d.success) setCanJudgeAcuity((d.data?.permissions ?? []).includes("patient.acuity.edit"));
        if (d.success) setCanRecordCalls((d.data?.permissions ?? []).includes("visits.create"));
        if (d.success) setCanVoidCalls((d.data?.permissions ?? []).includes("visits.edit"));
        if (d.success) setCanAckAlerts((d.data?.permissions ?? []).includes("careplans.edit"));
        if (d.success) setCanRaiseCharge((d.data?.permissions ?? []).includes("visits.submit"));
        if (d.success) {
          setCanViewBill(
            (d.data?.permissions ?? []).includes("billing.superbills.view") || d.data?.role === "platform_admin",
          );
        }
        if (d.success) setCanSeeAllVisits((d.data?.permissions ?? []).includes("visits.view.all"));
        if (d.success) {
          const perms: string[] = d.data?.permissions ?? [];
          setCanEditAuths(perms.includes("patients.edit") || perms.includes("billing.superbills.edit"));
        }
        const can =
          d.success &&
          ((d.data?.permissions ?? []).includes("patients.careteam.edit") ||
            d.data?.role === "platform_admin");
        if (can) {
          setCanEditCareTeam(true);
          return fetch("/api/team/members?active=1")
            .then((r) => r.json())
            .then((m) => {
              if (m.success) setRoster(m.data?.rows ?? []);
            });
        }
      })
      .catch(() => {});
  }, []);

  async function assignSeat(field: string, userId: string | null, seat: "primaryNp" | "rn" | "socialWorker" | "chaplain" | "billingAgent") {
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

  /** After a card saves: the record as stored, which the next edit starts from. */
  async function reloadPatient() {
    try {
      const r = await fetch(`/api/patients/${id}`);
      const d = await r.json();
      if (d.success) setPatient(d.data);
    } catch {
      /* the save went through; the chart shows it on the next load */
    }
  }

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const [pRes, vRes] = await Promise.all([
          fetch(`/api/patients/${id}`),
          // 200, the list API's own maximum and what the superbills card below
          // already asks for. At 50 a 206-visit patient had 156 visits — the
          // start of the illness — reachable from nowhere in the product; the
          // count beside the tab made that honest without making it readable.
          fetch(`/api/visits?patientId=${id}&limit=200`),
        ]);
        const p = await pRes.json();
        const v = await vRes.json();
        if (abandoned) return;
        if (!p.success) {
          setError(p.error ?? "Patient not found.");
          return;
        }
        setPatient(p.data);
        if (v.success) {
          setVisits(v.data.rows ?? []);
          setVisitTotal(Number(v.data?.total ?? 0));
          setVisitsWithheld(Number(v.data?.withheld ?? 0));
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
            {patient.referral && (
              <>
                {" · "}
                <Link href={`/referrals/${patient.referral.id}`} className="text-[var(--color-brand-700)] hover:underline">
                  Referred {patient.referral.receivedOn}
                  {patient.referral.sourceName ? ` by ${patient.referral.sourceName}` : ""}
                </Link>
              </>
            )}
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

      {/* Just admitted from a referral: the next step at intake is the initial
          NP visit (Level-1 doc:28). From the record's own visit days, not the
          visit list, which shows intake only their own visits. */}
      {patient.status === "active" && patient.referral && !patient.lastVisitDate && !patient.nextVisitDate && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span>Admitted from a referral. Next: the initial NP visit.</span>
          <Link href={`/schedule?patientId=${id}`} className="font-medium underline">
            Schedule the first visit →
          </Link>
        </div>
      )}

      {/* No longer under care (0115): the discharge, the hospice outcome and
          readmission are on the Course tab. */}
      {(patient.status === "discharged" || patient.status === "deceased") && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
          <span>{patient.status === "deceased" ? "Died" : "Discharged"}: no longer under the practice&rsquo;s care.</span>
          {tab !== "course" && (
            <button type="button" onClick={() => showTab("course")} className="font-medium underline">
              The discharge and what followed →
            </button>
          )}
        </div>
      )}

      {/* Escalation alerts waiting (0116, doc:55-57), on every tab. */}
      <AlertsBanner
        patientId={id}
        me={selfUserId}
        canAcknowledge={canAckAlerts}
        canGiveTask={canEditPatient}
        version={alertsVersion}
        onChanged={bumpAlerts}
      />

      <div className="border-b border-slate-200 mb-6 flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => showTab(t)}
            className={`shrink-0 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
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
          {/* Editable in place (audit 27 Oct, doc:21-23); each card saves its
              own section and the chart re-reads the record. */}
          <IdentityCard patient={patient} canEdit={canEditPatient} onSaved={reloadPatient} />
          <InsuranceCard patient={patient} canEdit={canEditPatient} onSaved={reloadPatient} />
          <ClinicalCard
            patient={patient}
            canEdit={canEditPatient}
            onSaved={reloadPatient}
            acuity={
              <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
                <span className="text-slate-500">Acuity</span>
                <select
                  value={patient.acuity ?? ""}
                  aria-label="Patient acuity"
                  disabled={!canJudgeAcuity}
                  className="h-8 px-2 rounded-md border border-slate-300 bg-white text-sm disabled:bg-slate-50 disabled:text-slate-600"
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
            }
          />
          <ConsentsCard patient={patient} canEdit={canEditPatient} onSaved={reloadPatient} />
          {/* Problems, allergies and medications (0114, doc:36). */}
          <ClinicalListsCards patientId={id} canEdit={canEditPatient} />
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Care team</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm text-slate-700">
              {([
                ["Primary NP", "primaryNpUserId", "primaryNp"],
                ["RN", "rnUserId", "rn"],
                ["Social worker", "socialWorkerUserId", "socialWorker"],
                ["Chaplain", "chaplainUserId", "chaplain"],
                ["Billing agent", "billingAgentUserId", "billingAgent"],
              ] as const).map(([label, field, seat]) => (
                <div key={field} className="flex items-center justify-between gap-3">
                  <span className="text-slate-500">{label}</span>
                  {canEditCareTeam ? (
                    <select
                      value={patient.careTeam[seat].userId ?? ""}
                      aria-label={`Assign ${label}`}
                      className="h-8 px-2 rounded-md border border-slate-300 bg-white text-sm max-w-56"
                      onChange={(e) => void assignSeat(field, e.target.value || null, seat)}
                    >
                      <option value="">— unassigned —</option>
                      {/* Current assignee may be missing from the ACTIVE roster
                          (suspended/removed since assignment). Without this
                          option the controlled select renders blank — reading
                          as unassigned and inviting a silent overwrite. */}
                      {patient.careTeam[seat].userId &&
                        !roster.some((m) => m.userId === patient.careTeam[seat].userId) && (
                          <option value={patient.careTeam[seat].userId}>
                            {patient.careTeam[seat].name ?? "assigned (former staff)"}
                          </option>
                        )}
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
          {/* Family, caregivers and outside providers (audit R30). Each card
              loads its own endpoint. */}
          <PatientContactsCard patientId={id} canEdit={canEditPatient} className="md:col-span-2" />
          <ExternalProvidersCard patientId={id} canEdit={canEditPatient} className="md:col-span-2" />
          <PriorAuthsCard patientId={id} canEdit={canEditAuths} className="md:col-span-2" />
          {/* Referral paperwork and other documents (0112, Mark Q11j). */}
          <DocumentsCard
            url={`/api/patients/${id}/documents`}
            canEdit={canEditPatient}
            title="Documents"
            description="Orders, records, face sheets, insurance cards and signed consents, including what came with the referral."
            emptyText="None on file."
            showOrigin
            className="md:col-span-2"
          />
        </div>
      )}

      {tab === "course" && (
        <ClinicalCourseTab
          patientId={id}
          canEdit={canEditPatient}
          canJudge={canJudgeAcuity}
          nextVisitDate={patient.nextVisitDate}
          onStatusChange={reloadPatient}
          onRecorded={bumpAlerts}
        />
      )}

      {tab === "calls" && (
        <CallsTab
          patientId={id}
          canRecord={canRecordCalls}
          canVoid={canVoidCalls}
          canGiveTask={canEditPatient}
          canRaiseCharge={canRaiseCharge}
          canViewBill={canViewBill}
          onChanged={bumpAlerts}
        />
      )}

      {tab === "tasks" && <PatientTasks patientId={id} me={selfUserId} canEdit={canEditPatient} />}

      {tab === "visits" && (
        <Card>
          <CardHeader>
            <CardTitle>Visits</CardTitle>
            {/* "on file" has to mean on file. The fetch asks for the newest
                200, so a patient with more than that is told the page is a
                page — the oldest visits, the start of the illness, are the
                ones behind it. Same shape as the billing tab below. */}
            <CardDescription>
              {visitsOnFile({ listed: visits.length, total: visitTotal, withheld: visitsWithheld })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {visits.length === 0 ? (
              visitsWithheld === 0 && <p className="text-sm text-slate-500">No visits yet. Schedule one above.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {visits.map((v) => (
                  <li key={v.id} className="py-2 flex items-center justify-between text-sm">
                    <div>
                      <span className="font-medium">{v.visitType.replace(/_/g, " ")}</span>
                      <span className="text-slate-500 tabular">
                        {" · "}
                        {/* The practice's day; slicing the instant gave its UTC
                            day, a day late for an Ohio evening visit. A visit
                            with no time yet shows the day it was booked. */}
                        {v.serviceDay ?? v.createdAt.slice(0, 10)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 capitalize">{v.status.replace(/_/g, " ")}</span>
                      {canSeeAllVisits || v.clinicianUserId === selfUserId ? (
                        <Link
                          href={`/visits/${v.id}/document`}
                          className="text-xs text-[var(--color-brand-700)] hover:underline"
                        >
                          Open →
                        </Link>
                      ) : (
                        // A colleague's visit, listed because this reader is on
                        // the patient's care team: read only.
                        <Link
                          href={`/visits/${v.id}/view`}
                          className="text-xs text-[var(--color-brand-700)] hover:underline"
                        >
                          Read →
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "vitals" && <VitalsTrend patientId={id} />}

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

/**
 * HIPAA right-of-access export — fetches the patient record PDF from
 * /api/patients/[id]/export and triggers a browser download. The
 * server-side route writes a phi_export_log row.
 */
function ExportRecordButton({ patientId }: { patientId: string }) {
  const [downloading, setDownloading] = useState<"pdf" | "ccda" | null>(null);
  async function download(kind: "pdf" | "ccda") {
    setDownloading(kind);
    try {
      const res = await fetch(`/api/patients/${patientId}/export${kind === "ccda" ? "/ccda" : ""}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = kind === "ccda" ? `patient-${patientId}-ccd.xml` : `patient-${patientId}-record.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(null);
    }
  }
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => void download("pdf")}
        loading={downloading === "pdf"}
        title="Patient's HIPAA right-of-access export. Logged to phi_export_log."
      >
        Download record
      </Button>
      <Button
        variant="secondary"
        onClick={() => void download("ccda")}
        loading={downloading === "ccda"}
        title="The record as a C-CDA document another EHR can import. Logged to phi_export_log."
      >
        Download C-CDA
      </Button>
    </>
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
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  /** Why the bills are not listed. A refusal is not "no bills". */
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    // Filtered in SQL. This fetched the org's 200 newest bills and filtered
    // them here, so a patient whose bills were older than those 200 showed
    // none at all (audit R34).
    fetch(`/api/superbills?patientId=${patientId}&limit=200`)
      .then(async (r) => {
        const d = await r.json();
        if (abandoned) return;
        if (!d.success) {
          setProblem(
            r.status === 403
              ? "Billing staff can see this chart's bills. Your role doesn't open them."
              : "The bills could not be loaded.",
          );
          return;
        }
        setRows(d.data?.rows ?? []);
        setTotal(Number(d.data?.total ?? 0));
      })
      .catch(() => {
        if (!abandoned) setProblem("The bills could not be loaded.");
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
            : problem
              ? problem
              : rows.length === 0
                ? "No superbills yet — generate one from a documented visit."
                : `${total > rows.length ? `Latest ${rows.length} of ${total} superbills` : `${rows.length} superbill${rows.length === 1 ? "" : "s"}`} · $${(billed / 100).toFixed(2)} billed · $${(paid / 100).toFixed(2)} paid`}
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
