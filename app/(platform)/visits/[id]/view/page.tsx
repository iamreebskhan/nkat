/**
 * /visits/[id]/view — a visit to read, not to document.
 *
 * Level-1 doc:49: between visits the RN or LPN needs "immediate access to the
 * current care plan and relevant findings from prior visits". A member in the
 * patient's clinical care team may read the patient's visits
 * (visit-access.ts mayReadVisit) and change none of them, so this page shows
 * the finished note, the diagnoses and any addenda, and offers nothing to
 * edit. The documentation screen sends such a reader here.
 *
 * A PCM/CCM month's charge (0117) is carried on a signed visit with no note:
 * its record is the summary the charge wrote and the time log on the chart,
 * which is what this page shows for one, to everyone.
 */
"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotePreview } from "@/components/visits/note-preview";
import { VisitAddenda } from "@/components/visits/visit-addenda";
import { formatCodes } from "@/lib/features/billing/code-units";
import { usePracticeTime } from "@/lib/features/schedule/use-practice-zone";
import type { VisitView } from "@/lib/features/visits/visit.types";

const SIGNED = ["documented", "pending_billing", "billed"];

export default function VisitReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [visit, setVisit] = useState<VisitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether this reader may document the visit after all (their own, or
  // visits.view.all): then the documentation screen is offered instead.
  const [mayDocument, setMayDocument] = useState(false);
  // A PCM/CCM month links to its bill for whoever may open one, and to its
  // audit packet for whoever the packet's route lets export it.
  const [mayOpenBill, setMayOpenBill] = useState(false);
  const [mayExportPacket, setMayExportPacket] = useState(false);
  // When it was signed, on the practice's clock as the note itself prints it.
  const atPractice = usePracticeTime();

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const [vr, mr] = await Promise.all([fetch(`/api/visits/${id}`), fetch("/api/auth/me")]);
        const v = await vr.json();
        const me = await mr.json().catch(() => null);
        if (abandoned) return;
        if (!v.success) {
          setError(v.error ?? "Visit not found.");
          return;
        }
        const visitRow = v.data as VisitView;
        setVisit(visitRow);
        const perms: string[] = me?.data?.permissions ?? [];
        setMayDocument(
          visitRow.codingBasis !== "care_management" &&
            (perms.includes("visits.view.all") ||
              (perms.includes("visits.edit") && me?.data?.userId === visitRow.clinicianUserId)),
        );
        setMayOpenBill(perms.includes("billing.superbills.view") || me?.data?.role === "platform_admin");
        setMayExportPacket(
          perms.includes("billing.superbills.export") &&
            ["visits.view.all", "visits.view.own", "visits.edit"].some((p) => perms.includes(p)),
        );
      } catch {
        if (!abandoned) setError("Network error.");
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="px-8 py-8">
        <p role="alert" className="text-red-700">
          {error}
        </p>
      </div>
    );
  }
  if (!visit) return <div className="px-8 py-8 text-slate-500">Loading…</div>;

  const signed = SIGNED.includes(visit.status);

  if (visit.codingBasis === "care_management") {
    return (
      <div className="px-8 py-6 max-w-4xl">
        <header className="mb-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link href={`/patients/${visit.patientId}?tab=calls`} className="text-xs text-slate-500 hover:underline">
              ← The time log
            </Link>
            {mayOpenBill && (
              <Link href={`/visits/${visit.id}/superbill`} className="text-xs text-[var(--color-brand-700)] hover:underline">
                The bill →
              </Link>
            )}
            {mayExportPacket && (
              <a href={`/api/visits/${visit.id}/audit-packet`} className="text-xs text-[var(--color-brand-700)] hover:underline">
                Audit packet (PDF) →
              </a>
            )}
          </div>
          <h1 className="font-display text-2xl tracking-tight mt-1">{visit.visitTypeLabel}</h1>
          <p className="text-slate-600 mt-1 tabular text-sm">
            Date of service {visit.serviceDay ?? "—"} · {visit.status.replace(/_/g, " ")}
          </p>
          <p className="text-slate-500 mt-0.5 text-xs">
            {visit.signedAt
              ? `Raised and signed by ${visit.signerName ?? "a former team member"}${visit.signerCredential ? `, ${visit.signerCredential}` : ""} on ${atPractice(visit.signedAt)}.`
              : "Not signed."}{" "}
            A month of care management, billed from its time log: there is no visit note.
          </p>
        </header>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>The month&apos;s charge</CardTitle>
              <CardDescription>What was billed, on whose time, and the consent it rests on.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-mono">{formatCodes(visit.cptCodesAssigned, visit.cptUnits)}</p>
              <p className="whitespace-pre-line text-slate-700">{visit.documentText}</p>
              <p className="text-slate-600">
                Diagnoses <span className="font-mono">{visit.icd10Codes.join(" · ") || "—"}</span> · place of service{" "}
                {visit.placeOfServiceCode ?? "—"}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 py-6 max-w-4xl">
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link href={`/patients/${visit.patientId}?tab=visits`} className="text-xs text-slate-500 hover:underline">
            ← Patient
          </Link>
          <Link
            href={`/patients/${visit.patientId}/care-plan`}
            className="text-xs text-[var(--color-brand-700)] hover:underline"
          >
            Care plan →
          </Link>
          {mayDocument && (
            <Link
              href={`/visits/${visit.id}/document`}
              className="text-xs text-[var(--color-brand-700)] hover:underline"
            >
              Open the documentation →
            </Link>
          )}
        </div>
        <h1 className="font-display text-2xl tracking-tight mt-1">Visit · {visit.visitTypeLabel}</h1>
        <p className="text-slate-600 mt-1 tabular text-sm">
          {visit.serviceAt ?? visit.serviceDay ?? "Not yet scheduled"} · {visit.status.replace(/_/g, " ")}
        </p>
        <p className="text-slate-500 mt-0.5 text-xs">
          {signed && visit.signedAt
            ? `Signed by ${visit.signerName ?? "a former team member"}${visit.signerCredential ? `, ${visit.signerCredential}` : ""} on ${atPractice(visit.signedAt)}.`
            : "Not signed yet: the note below may still change."}{" "}
          Read only.
        </p>
      </header>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Diagnoses</CardTitle>
            <CardDescription>What this visit addressed (ICD-10).</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {visit.icd10Codes.length === 0 ? (
              <p className="text-slate-500">None recorded.</p>
            ) : (
              <p className="font-mono">{visit.icd10Codes.join(" · ")}</p>
            )}
          </CardContent>
        </Card>

        <NotePreview visitId={visit.id} />

        {signed && <VisitAddenda visitId={visit.id} canSign={false} />}
      </div>
    </div>
  );
}
