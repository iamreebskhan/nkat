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
import { CodeUnitsEditor } from "@/components/billing/code-units-editor";
import { Icd10Picker } from "@/components/billing/icd10-picker";
import { RiskBadge, RiskSummary, type RiskBand, type RiskReason } from "@/components/billing/risk-badge";
import { RuleSidebar } from "@/components/billing/rule-sidebar";
import { SubmissionDisclosure } from "@/components/billing/submission-disclosure";
import { TimeSpentPanel, type ThresholdBracket } from "@/components/billing/time-spent-panel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { unitWarnings, type CodeUnits } from "@/lib/features/billing/code-units";
import type { PatientView } from "@/lib/features/patients/patient.types";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";
import {
  describePriceSource,
  lineChargeCents,
  savedSuperbillWarnings,
  withHomeVisitCode,
  type PricedLine,
  type SuperbillPricing,
} from "@/lib/features/superbills/superbill-pure";
import { statusLabel } from "@/lib/features/superbills/superbill-queue";
import type { VisitCodeBands } from "@/lib/features/visits/cpt-suggester";
import { VISIT_POS_OPTIONS, posLabel } from "@/lib/features/visits/place-of-service";
import type { VisitView } from "@/lib/features/visits/visit.types";

interface SuperbillDraft {
  visitId: string;
  patientId: string;
  payerId: string | null;
  memberIdSnapshot: string;
  dateOfService: string;
  cptCodes: string[];
  /** Units per code when more than one (0106); {} = one each. */
  cptUnits: CodeUnits;
  icd10Codes: string[];
  modifiers: string[];
  providerNpi: string;
  providerName: string;
  /** Billing provider NPI (box 33a): the organization's. */
  billingNpi: string;
  placeOfServiceCode: string;
  billedAmountCents: number;
  /** Priced lines and where each price came from (audit R33). */
  ratedCodes: PricedLine[];
  unratedCodes: string[];
  warnings: string[];
}

/** A saved bill as the superbill routes return it. */
interface SavedBill {
  id: string;
  status?: string | null;
  visitId: string;
  patientId: string;
  payerId: string | null;
  memberIdSnapshot: string;
  dateOfService: string;
  cptCodes: string[];
  cptUnits?: CodeUnits | null;
  icd10Codes: string[];
  modifiers: string[];
  providerNpi: string;
  providerName: string;
  billingNpi?: string | null;
  placeOfServiceCode: string;
  billedAmountCents: number;
  pricing?: { lines?: PricedLine[] } | null;
}

/** The page's view of a saved bill. */
function savedToDraft(existing: SavedBill): SuperbillDraft {
  // Where the saved amount came from (audit R33); {} on bills priced before
  // pricing was recorded.
  const lines = existing.pricing?.lines ?? [];
  return {
    visitId: existing.visitId,
    patientId: existing.patientId,
    payerId: existing.payerId,
    memberIdSnapshot: existing.memberIdSnapshot,
    dateOfService: existing.dateOfService,
    cptCodes: existing.cptCodes,
    cptUnits: existing.cptUnits ?? {},
    icd10Codes: existing.icd10Codes,
    modifiers: existing.modifiers,
    providerNpi: existing.providerNpi,
    providerName: existing.providerName,
    billingNpi: existing.billingNpi ?? "",
    placeOfServiceCode: existing.placeOfServiceCode,
    billedAmountCents: existing.billedAmountCents,
    ratedCodes: lines.filter((l) => l.source !== "unrated"),
    unratedCodes: lines.filter((l) => l.source === "unrated").map((l) => l.code),
    // The persisted row doesn't carry the per-code rate breakdown. Its
    // warnings are re-derived from what the row does carry — they used to be
    // dropped, so a saved bill with no NPI or no member ID showed nothing to
    // verify.
    warnings: savedSuperbillWarnings(existing),
  };
}

/** Local edits applied to the draft, not yet saved. */
interface BillEdits {
  cpt?: string[];
  /** Units on a per-increment add-on, corrected on the bill (0106). */
  units?: CodeUnits;
  icd10?: string[];
  modifiers?: string[];
  /** Place of service corrected on the bill (audit R23). */
  pos?: string;
  pendingOverrides?: Array<{ code: string; reason: string }>;
}

/** What unsaved edits touch, in words. */
function editedParts(e: BillEdits): string[] {
  return [
    e.cpt !== undefined || (e.pendingOverrides?.length ?? 0) > 0 ? "the CPT codes" : null,
    e.units !== undefined ? "the units" : null,
    e.icd10 !== undefined ? "the diagnoses" : null,
    e.modifiers !== undefined ? "the modifiers" : null,
    e.pos !== undefined ? "the place of service" : null,
  ].filter((p): p is string => p !== null);
}

/** "a", "a and b", "a, b and c". */
function inWords(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export default function SuperbillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [draft, setDraft] = useState<SuperbillDraft | null>(null);
  const [persistedId, setPersistedId] = useState<string | null>(null);
  // The saved bill's status: place of service is editable only while the
  // bill is (draft, ready to submit, denied).
  const [status, setStatus] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [patient, setPatient] = useState<PatientView | null>(null);
  // Coverage rules key on the POLICY's state. Fall back to the address state
  // for patients recorded before insurance_state existed.
  const coverageState = patient?.insuranceState ?? patient?.state ?? null;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local edits applied to the draft; flushed to the server via
  // PATCH (after first save) or POST (when saving for the first time).
  const [edits, setEdits] = useState<BillEdits>({});
  /**
   * Set when Save found the visit already billed — saved since this page
   * loaded — and the page switched to that bill: what the unsaved edits had
   * touched, which were not applied to it.
   */
  const [alreadyBilled, setAlreadyBilled] = useState<string[] | null>(null);
  /** Bumped when a saved bill replaces the page's draft, to reset the uncontrolled modifiers field. */
  const [billLoads, setBillLoads] = useState(0);

  interface PredictResult {
    worstBand: RiskBand;
    blockCount: number;
    highCount: number;
    mediumCount: number;
    perLine: Array<{
      code: string;
      score: number;
      riskBand: RiskBand;
      reasons: RiskReason[];
    }>;
  }
  const [risk, setRisk] = useState<PredictResult | null>(null);
  const [minutes, setMinutes] = useState<number>(0);
  /**
   * What the Time spent panel codes against: the visit's ACP minutes and the
   * ladder for its band. Null while loading; "unavailable" if either read
   * failed, when the panel suggests nothing rather than guess a ladder.
   */
  const [timeBasis, setTimeBasis] = useState<
    { acpMinutes: number; brackets: ThresholdBracket[] } | "unavailable" | null
  >(null);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  /**
   * The day the visit started where the practice is (0107): what a bill's date
   * of service should be. A bill drafted before 0107 may carry the next day.
   */
  const [visitServiceDay, setVisitServiceDay] = useState<string | null>(null);
  const [correctingDate, setCorrectingDate] = useState(false);
  /** Bumped after a change the bill's history records, so it reads it again. */
  const [historyKey, setHistoryKey] = useState(0);

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
          setStatus(data.data.existing.status ?? null);
          setDraft(savedToDraft(data.data.existing as SavedBill));
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

  // The Time spent panel starts from the visit's documented minutes, and
  // codes them on the visit's own ladder with its ACP minutes taken out. It
  // used to start at 0 on the established ladder whatever the visit was.
  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const [vd, bd] = await Promise.all([
          fetch(`/api/visits/${id}`).then((r) => r.json()),
          fetch("/api/billing/code-bands").then((r) => r.json()),
        ]);
        if (abandoned) return;
        if (!vd.success || !bd.success) {
          setTimeBasis("unavailable");
          return;
        }
        const v = vd.data as VisitView;
        setVisitServiceDay(v.serviceDay ?? null);
        const bands = bd.data as VisitCodeBands;
        const ladder =
          v.codingBasis === "new_patient_home"
            ? bands.newPatientHome
            : v.codingBasis === "established_patient_home"
              ? bands.establishedPatientHome
              : [];
        setTimeBasis({
          acpMinutes: v.acpMinutes ?? 0,
          // The open top band arrives as null: JSON has no Infinity.
          brackets: ladder.map((b) => ({
            min: b.minMinutes,
            max: Number.isFinite(b.maxMinutes) ? b.maxMinutes : Number.POSITIVE_INFINITY,
            code: b.code,
          })),
        });
        setMinutes(v.totalMinutes ?? 0);
      } catch {
        if (!abandoned) setTimeBasis("unavailable");
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [id]);

  // Phase C — autosave: every 5s, if there are unflushed edits and we
  // already have a persisted superbill, PATCH them quietly.
  useEffect(() => {
    if (!persistedId) return;
    const hasEdits =
      edits.cpt !== undefined ||
      edits.units !== undefined ||
      edits.icd10 !== undefined ||
      edits.modifiers !== undefined ||
      edits.pos !== undefined ||
      (edits.pendingOverrides && edits.pendingOverrides.length > 0);
    if (!hasEdits) return;
    const t = setTimeout(async () => {
      setAutosaveStatus("saving");
      try {
        const r = await fetch(`/api/superbills/${persistedId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            patch: {
              ...(edits.cpt && { cptCodes: edits.cpt }),
              ...(edits.units && { cptUnits: edits.units }),
              ...(edits.icd10 && { icd10Codes: edits.icd10 }),
              ...(edits.modifiers && { modifiers: edits.modifiers }),
              ...(edits.pos && { placeOfServiceCode: edits.pos }),
            },
            overrides: edits.pendingOverrides ?? [],
          }),
        });
        const data = await r.json();
        if (data.success) {
          setDraft((d) =>
            d
              ? {
                  ...d,
                  ...savedCodes(d, edits.cpt, data.data),
                  icd10Codes: edits.icd10 ?? d.icd10Codes,
                  modifiers: edits.modifiers ?? d.modifiers,
                  placeOfServiceCode: edits.pos ?? d.placeOfServiceCode,
                  // The server repriced the bill if the codes, units or place changed.
                  ...repricedFields(data.data),
                }
              : d,
          );
          setEdits({});
          // An edit to a reviewed bill sends it back to draft (audit R26).
          if (data.data?.status) setStatus(data.data.status);
          setAutosaveStatus("saved");
          setTimeout(() => setAutosaveStatus("idle"), 1500);
        } else {
          setAutosaveStatus("error");
        }
      } catch {
        setAutosaveStatus("error");
      }
    }, 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedId, JSON.stringify(edits)]);

  // Phase B — debounced predictor call. Re-runs whenever the codes,
  // modifiers, payer or state change. Preview-only; the persist hook
  // captures the same data into superbill.predicted_risk server-side.
  const currentCptsForPredict = edits.cpt ?? draft?.cptCodes ?? [];
  const currentModsForPredict = edits.modifiers ?? draft?.modifiers ?? [];
  const dosForPredict = draft?.dateOfService;
  useEffect(() => {
    if (!dosForPredict || currentCptsForPredict.length === 0) {
      // Nothing to score. Cleared from a timer rather than synchronously in
      // the effect body, which would cascade a second render.
      const t = setTimeout(() => setRisk(null), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/superbills/predict", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            payerId: patient?.primaryPayerId ?? draft?.payerId ?? null,
            state: coverageState,
            patientId: draft?.patientId,
            dos: dosForPredict,
            cptCodes: currentCptsForPredict,
            modifiers: currentModsForPredict,
            // The saved bill, once there is one: its note is checked against
            // the payer's documentation standard (audit R19), and its own
            // lines stop counting as prior history for the frequency check.
            superbillId: persistedId ?? undefined,
            // Before the bill is saved, the visit's own note is checked.
            visitId: persistedId ? undefined : id,
          }),
        });
        const data = await r.json();
        if (data.success && data.data) setRisk(data.data as PredictResult);
      } catch {
        /* keep prior */
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dosForPredict,
    currentCptsForPredict.join(","),
    currentModsForPredict.join(","),
    patient?.primaryPayerId,
    coverageState,
    draft?.payerId,
    persistedId,
  ]);

  async function persist() {
    // Phase B — pre-submit summary modal. Block-band or high-band lines
    // require an explicit confirmation so the nurse pauses.
    if (risk && (risk.blockCount > 0 || risk.highCount > 0)) {
      const ok = window.confirm(
        `Predictor flags ${risk.blockCount} likely denial(s), ${risk.highCount} high-risk, ${risk.mediumCount} medium. Save anyway?`,
      );
      if (!ok) return;
    }
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
        if (data.data.created === false && data.data.existing) {
          // Billed since this page loaded: at sign-off, by someone else, or in
          // another tab. That bill is shown as it stands, and the edits made
          // here are not written over it — they were made to the visit's
          // draft, not to that bill.
          const saved = data.data.existing as SavedBill;
          setPersistedId(saved.id);
          setStatus(saved.status ?? null);
          setDraft(savedToDraft(saved));
          setAlreadyBilled(editedParts(edits));
          setEdits({});
          setBillLoads((n) => n + 1);
          return;
        }
        id1 = data.data.id;
        setPersistedId(id1);
        setStatus("draft");
        if (data.data.draft) setDraft(data.data.draft);
      }

      const hasEdits =
        edits.cpt !== undefined ||
        edits.units !== undefined ||
        edits.icd10 !== undefined ||
        edits.modifiers !== undefined ||
        edits.pos !== undefined ||
        (edits.pendingOverrides && edits.pendingOverrides.length > 0);
      if (hasEdits && id1) {
        const pr = await fetch(`/api/superbills/${id1}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            patch: {
              ...(edits.cpt && { cptCodes: edits.cpt }),
              ...(edits.units && { cptUnits: edits.units }),
              ...(edits.icd10 && { icd10Codes: edits.icd10 }),
              ...(edits.modifiers && { modifiers: edits.modifiers }),
              ...(edits.pos && { placeOfServiceCode: edits.pos }),
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
                ...savedCodes(d, edits.cpt, pdata.data),
                icd10Codes: edits.icd10 ?? d.icd10Codes,
                modifiers: edits.modifiers ?? d.modifiers,
                placeOfServiceCode: edits.pos ?? d.placeOfServiceCode,
                ...repricedFields(pdata.data),
              }
            : d,
        );
        if (pdata.data?.status) setStatus(pdata.data.status);
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
  // Place of service can be corrected on the bill while it is editable (R23).
  const posEditable = !status || ["draft", "ready_to_submit", "denied"].includes(status);
  const hasPendingEdits =
    edits.cpt !== undefined ||
    edits.units !== undefined ||
    edits.icd10 !== undefined ||
    edits.modifiers !== undefined ||
    edits.pos !== undefined ||
    (edits.pendingOverrides?.length ?? 0) > 0;

  /**
   * The review checkpoint (audit R26). A draft goes out only after someone
   * marks it ready here, with the bill and its rule check on screen; the queue
   * no longer offers draft → submitted.
   */
  async function markReady() {
    if (!persistedId) return;
    if (risk && risk.blockCount > 0) {
      const ok = window.confirm(
        `Predictor flags ${risk.blockCount} likely denial(s). Mark ready to submit anyway?`,
      );
      if (!ok) return;
    }
    setMarking(true);
    try {
      const r = await fetch(`/api/superbills/${persistedId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "ready_to_submit" }),
      });
      const d = await r.json();
      if (!d.success) {
        alert(d.error ?? "Could not mark it ready to submit.");
        return;
      }
      setStatus("ready_to_submit");
    } catch {
      alert("Network error — status not changed.");
    } finally {
      setMarking(false);
    }
  }

  /** Re-date the bill to its visit's day, repriced for that day (0107). */
  async function correctDate() {
    if (!persistedId) return;
    setCorrectingDate(true);
    try {
      const r = await fetch(`/api/superbills/${persistedId}/correct-date`, { method: "POST" });
      const d = await r.json();
      if (!d.success) {
        alert(d.error ?? "Could not correct the date.");
        return;
      }
      setDraft((cur) =>
        cur ? { ...cur, dateOfService: d.data.to, billedAmountCents: d.data.billedAmountCents } : cur,
      );
      setStatus(d.data.status);
      setHistoryKey((k) => k + 1);
    } catch {
      alert("Network error — date not changed.");
    } finally {
      setCorrectingDate(false);
    }
  }

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
          DOS {draft.dateOfService} · POS {posLabel(edits.pos ?? draft.placeOfServiceCode)} ·{" "}
          {persistedId ? "saved" : "draft (in-memory)"}
          {status && <span className="ml-1">· {statusLabel(status)}</span>}
          {/* Entered as box 26 on the claim, so the payer's 835 matches back (audit R10). */}
          {persistedId && <span className="ml-1" title="Enter this as the Patient account no. (CMS-1500 box 26) when you submit the claim.">· Claim ref <span className="font-mono">{claimRefFor(persistedId)}</span></span>}
          {autosaveStatus === "saving" && <span className="ml-2 text-slate-500">· saving…</span>}
          {autosaveStatus === "saved" && <span className="ml-2 text-emerald-700">· autosaved ✓</span>}
          {autosaveStatus === "error" && <span className="ml-2 text-red-700">· autosave failed</span>}
        </p>
        {/* This header prints the claim's status and the card below it prints
            the billed amount, and this is the page the queue's "Open →" link
            lands on — so it is a billing screen in every sense that matters to
            someone reading it (audit R35). "Mark ready to submit" below sends
            nothing; a person still files the claim elsewhere. */}
        <SubmissionDisclosure />
      </header>

      {alreadyBilled && (
        <Card severity="warn" className="mb-4">
          <CardHeader>
            <CardTitle>This visit already had a bill</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-amber-900">
              It was saved while this page was open, so it is shown below as it now stands, and
              nothing from this page was saved over it.
              {alreadyBilled.length > 0 &&
                ` Your changes to ${inWords(alreadyBilled)} were not applied. Make them again if they are still needed.`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Only while the bill is still being worked: a submitted claim's date
          is the one the payer holds, and is never changed here. */}
      {persistedId &&
        (status === "draft" || status === "ready_to_submit") &&
        visitServiceDay &&
        draft.dateOfService !== visitServiceDay && (
          <Card severity="warn" className="mb-4">
            <CardHeader>
              <CardTitle>Date of service</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-amber-900">
                This bill is dated {draft.dateOfService}, but the visit started on {visitServiceDay}{" "}
                where the practice is. Bills drafted before Pallio dated visits in the
                practice&apos;s own time zone took the next day for evening visits.
              </p>
              <Button variant="secondary" loading={correctingDate} onClick={() => void correctDate()}>
                Correct the date to {visitServiceDay}
              </Button>
            </CardContent>
          </Card>
        )}

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

      {risk && (
        <div className="mb-4">
          <RiskSummary
            worstBand={risk.worstBand}
            blockCount={risk.blockCount}
            highCount={risk.highCount}
            mediumCount={risk.mediumCount}
          />
          {risk.perLine.some((p) => p.riskBand !== "low") && (
            <ul className="mt-2 space-y-1.5 text-xs">
              {risk.perLine
                .filter((p) => p.riskBand !== "low")
                .map((p) => (
                  <li key={p.code} className="flex items-center gap-2">
                    <span className="font-mono tabular text-slate-700">{p.code}</span>
                    <RiskBadge
                      band={p.riskBand}
                      score={p.score}
                      reasons={p.reasons}
                      cptCode={p.code}
                      payerId={patient?.primaryPayerId ?? draft?.payerId}
                      state={coverageState}
                    />
                  </li>
                ))}
            </ul>
          )}
        </div>
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
          <Row
            label="Rendering provider"
            value={`${draft.providerName || "—"} · NPI ${draft.providerNpi || "not recorded"}`}
          />
          <Row label="Billing provider NPI" value={draft.billingNpi || "not recorded"} mono />
          {posEditable ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">Place of service</span>
              <select
                aria-label="Place of service"
                value={edits.pos ?? draft.placeOfServiceCode}
                onChange={(e) => setEdits((eds) => ({ ...eds, pos: e.target.value }))}
                className="h-8 px-2 border border-slate-300 rounded-md text-sm"
              >
                {!VISIT_POS_OPTIONS.some((o) => o.code === (edits.pos ?? draft.placeOfServiceCode)) && (
                  <option value={edits.pos ?? draft.placeOfServiceCode}>
                    {edits.pos ?? draft.placeOfServiceCode}
                  </option>
                )}
                {VISIT_POS_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.code} · {o.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <Row label="Place of service" value={posLabel(draft.placeOfServiceCode)} />
          )}
          <Row
            label="Billed"
            value={`$${(draft.billedAmountCents / 100).toFixed(2)}`}
            mono
          />
          <PricingLines rated={draft.ratedCodes} unrated={draft.unratedCodes} />
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Time spent</CardTitle>
          <CardDescription>
            Code suggestions update as you adjust the minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {timeBasis === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : timeBasis === "unavailable" ? (
            <p role="alert" className="text-sm text-amber-800">
              The visit&rsquo;s time could not be loaded, so no code is suggested here. Reload
              the page.
            </p>
          ) : (
            <TimeSpentPanel
              minutes={minutes}
              onChange={setMinutes}
              // Not past the statuses a bill can still be edited in, like the
              // units and the place of service.
              disabled={!posEditable}
              acpMinutes={timeBasis.acpMinutes}
              brackets={timeBasis.brackets}
              selectedCodes={currentCpts}
              onUseSuggestion={(code) =>
                setEdits((e) => ({
                  ...e,
                  cpt: withHomeVisitCode(e.cpt ?? draft?.cptCodes ?? [], code),
                }))
              }
            />
          )}
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
            state={coverageState}
            selected={currentCpts}
            onChange={(cpt) => setEdits((e) => ({ ...e, cpt }))}
            onOverride={(o) =>
              setEdits((e) => ({
                ...e,
                pendingOverrides: [...(e.pendingOverrides ?? []), o],
              }))
            }
          />
          {/* Units on G0318 / 99417 / 99498 (0106); no input for any other code. */}
          <CodeUnitsEditor
            codes={currentCpts}
            units={edits.units ?? draft.cptUnits}
            onChange={(units) => setEdits((e) => ({ ...e, units }))}
            disabled={!posEditable}
          />
          <hr className="my-4 border-slate-100" />
          <div className="text-xs text-slate-500 font-medium mb-1">ICD-10 diagnoses</div>
          <Icd10Picker
            selected={edits.icd10 ?? draft.icd10Codes}
            onChange={(icd10) => setEdits((eds) => ({ ...eds, icd10 }))}
          />
          <label className="block mt-3 text-xs text-slate-500 font-medium">
            Modifiers (comma-separated)
            <input
              // Uncontrolled: remounted when a saved bill replaces the draft,
              // so it shows that bill's modifiers.
              key={billLoads}
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
            state={coverageState}
            cptCodes={currentCpts}
            attribute="covered"
          />
          {/* The payer's place-of-service rules, shown rather than evaluated:
              most are free text (audit R23). */}
          <div className="text-xs text-slate-500 font-medium mt-4 mb-1">
            Place-of-service rules
          </div>
          <RuleSidebar
            payerId={patient?.primaryPayerId ?? draft.payerId}
            state={coverageState}
            cptCodes={currentCpts}
            attribute="pos_allowed"
          />
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={persist} loading={saving}>
          {persistedId ? "Re-save" : "Save superbill"}
        </Button>
        <Button
          variant="secondary"
          disabled={
            !persistedId ||
            status !== "draft" ||
            hasPendingEdits ||
            autosaveStatus === "saving" ||
            marking
          }
          onClick={markReady}
        >
          {marking ? "Marking…" : "Mark ready to submit"}
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

      <ServicesProvided visitId={id} />

      {persistedId && <BillActivity key={historyKey} superbillId={persistedId} />}
    </div>
  );
}

/**
 * What the clinician recorded as provided on the visit — read-only here.
 * Client walkthrough [02:36–02:47]. Gives the biller the context behind the
 * codes without opening the note.
 */
function ServicesProvided({ visitId }: { visitId: string }) {
  const [rows, setRows] = useState<
    { serviceId: string; name: string; cptHint: string | null; minutes: number | null }[] | null
  >(null);

  useEffect(() => {
    fetch(`/api/visits/${visitId}/services`)
      .then((r) => r.json())
      .then((d) => setRows(d.success ? d.data.services : []))
      .catch(() => setRows([]));
  }, [visitId]);

  if (!rows || rows.length === 0) return null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Services provided</CardTitle>
        <CardDescription>Recorded by the clinician on this visit.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-wrap gap-2">
          {rows.map((s) => (
            <li
              key={s.serviceId}
              className="rounded-md bg-slate-50 px-2.5 py-1 text-sm text-slate-700 ring-1 ring-inset ring-slate-200"
            >
              {s.name}
              {s.minutes !== null && (
                <span className="ml-1.5 tabular text-xs text-slate-500">{s.minutes} min</span>
              )}
              {s.cptHint && (
                <span className="ml-1.5 font-mono text-[11px] text-slate-500">{s.cptHint}</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface ActivityRow {
  id: string;
  at: string;
  actorName: string | null;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  summary: string;
}

const KIND_STYLE: Record<string, string> = {
  created: "bg-slate-100 text-slate-700 ring-slate-500/20",
  edited: "bg-blue-50 text-blue-800 ring-blue-600/20",
  status_change: "bg-slate-100 text-slate-700 ring-slate-500/20",
  denial_logged: "bg-red-50 text-red-800 ring-red-600/30",
  denial_decision: "bg-amber-50 text-amber-800 ring-amber-600/30",
  resubmitted: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
};

/**
 * Append-only trail: created → submitted → denied → corrected → resubmitted.
 * Client walkthrough [06:12]: "activity history lazmi likhna: ke yeh pehle
 * bill tha, yeh reject hua, aur ab yeh new bill hai."
 */
function BillActivity({ superbillId }: { superbillId: string }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);

  useEffect(() => {
    fetch(`/api/superbills/${superbillId}/activity`)
      .then((r) => r.json())
      .then((d) => setRows(d.success ? (d.data?.rows ?? []) : []))
      .catch(() => setRows([]));
  }, [superbillId]);

  if (!rows || rows.length === 0) return null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Activity history</CardTitle>
        <CardDescription>
          Every change to this claim, newest first. Append-only — nothing here is
          ever edited or removed.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-slate-100">
          {rows.map((a) => (
            <li key={a.id} className="px-4 py-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      KIND_STYLE[a.kind] ?? "bg-slate-100 text-slate-700 ring-slate-500/20"
                    }`}
                  >
                    {a.kind.replace(/_/g, " ")}
                  </span>
                  <span className="text-sm text-slate-800">{a.summary}</span>
                </div>
                {a.fromStatus && a.toStatus && a.fromStatus !== a.toStatus && (
                  <p className="text-xs text-slate-500 mt-0.5 capitalize">
                    {a.fromStatus.replace(/_/g, " ")} → {a.toStatus.replace(/_/g, " ")}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-slate-500 tabular">
                  {new Date(a.at).toLocaleString()}
                </p>
                {a.actorName && <p className="text-xs text-slate-400">{a.actorName}</p>}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * The codes and units a successful PATCH saved (0106), as draft fields. The
 * units are the server's — normalized, so a removed code took its units with
 * it — never the edit the page sent, which would show a stale × 2 on a code
 * re-added at one unit. The G0318 cap warning is swapped for the one the saved
 * units raise, so it appears or clears without a reload; the other warnings
 * are left as they were.
 */
function savedCodes(
  d: SuperbillDraft,
  editedCodes: string[] | undefined,
  res: { cptUnits?: CodeUnits } | undefined,
): Pick<SuperbillDraft, "cptCodes" | "cptUnits" | "warnings"> {
  const cptCodes = editedCodes ?? d.cptCodes;
  const cptUnits = res?.cptUnits ?? d.cptUnits;
  const stale = new Set(unitWarnings(d.cptCodes, d.cptUnits));
  return {
    cptCodes,
    cptUnits,
    warnings: [...d.warnings.filter((w) => !stale.has(w)), ...unitWarnings(cptCodes, cptUnits)],
  };
}

/** The reprice a PATCH reports (audit R33), as draft fields. */
function repricedFields(
  res: { billedAmountCents?: number; pricing?: SuperbillPricing } | undefined,
): Partial<SuperbillDraft> {
  if (!res?.pricing || res.billedAmountCents === undefined) return {};
  return {
    billedAmountCents: res.billedAmountCents,
    ratedCodes: res.pricing.lines.filter((l) => l.source !== "unrated"),
    unratedCodes: res.pricing.lines.filter((l) => l.source === "unrated").map((l) => l.code),
  };
}

/**
 * Where each line's price came from (audit R33), under the billed amount. A
 * line with more than one unit shows the per-unit rate and its charge (0106):
 * "G0318 × 4 · $24.97 = $99.88". Lines saved before 0106 carry no units and
 * read as one.
 */
function PricingLines({ rated, unrated }: { rated: PricedLine[]; unrated: string[] }) {
  if (rated.length === 0 && unrated.length === 0) return null;
  return (
    <ul aria-label="How this bill was priced" className="mt-1 space-y-0.5 text-xs text-slate-600">
      {rated.map((l) => (
        <li key={l.code} className="tabular">
          <span className="font-mono">{l.code}</span>
          {(l.units ?? 1) > 1
            ? ` × ${l.units} · $${(l.rateCents / 100).toFixed(2)} = $${(lineChargeCents(l) / 100).toFixed(2)}`
            : ` · $${(l.rateCents / 100).toFixed(2)}`}{" "}
          · {describePriceSource(l)}
        </li>
      ))}
      {unrated.map((c) => (
        <li key={c} className="tabular text-amber-800">
          <span className="font-mono">{c}</span> · no rate on file — set the charge
        </li>
      ))}
    </ul>
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
