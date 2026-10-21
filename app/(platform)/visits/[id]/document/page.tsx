/**
 * /visits/[id]/document — clinician's primary tool.
 *
 * Source: pallio_complete_vision_v3 §6.4 + §7.2.
 *
 * Single screen with:
 *   - Time tracker (start / stop, total minutes computed live)
 *   - Telehealth toggle + modality select + consent acknowledgment
 *   - CPT suggestion panel (live, from `suggestCodes` pure function)
 *   - TipTap document body
 *   - "Save draft" + "Sign + submit for billing" buttons
 *
 * The CPT suggester runs entirely client-side from the pure function
 * — no API call needed for the preview. The suggested codes, and the
 * units of any per-increment add-on (G0318, 99417, 99498), are persisted
 * into `cpt_codes_assigned` and `cpt_units` only when the clinician saves.
 */
"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";

import type { PacketFinding } from "@/lib/features/visits/audit-packet.service";

import { RuleSidebar } from "@/components/billing/rule-sidebar";
import { TipTapEditor } from "@/components/editor/tiptap-editor";
import { DiagnosisPicker } from "@/components/visits/diagnosis-picker";
import { NotePreview } from "@/components/visits/note-preview";
import { SectionedNote } from "@/components/visits/sectioned-note";
import { VisitAddenda } from "@/components/visits/visit-addenda";
import { VisitServicesPanel } from "@/components/visits/visit-services-panel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ESTABLISHED_PATIENT_HOME_CODES,
  NEW_PATIENT_HOME_CODES,
  acpOverTotalProblem,
  assignmentFromSuggestion,
  suggestCodes,
  type VisitCodeBands,
} from "@/lib/features/visits/cpt-suggester";
import {
  VISIT_POS_OPTIONS,
  defaultPosFor,
  posTelehealthConflict,
} from "@/lib/features/visits/place-of-service";
import {
  computeTotalMinutes,
  daysRemainingInMedicareWindow,
  isInsideMedicareWindow,
  visitTypeHistoryWarning,
} from "@/lib/features/visits/visit-pure";
import {
  NEW_PATIENT_LOOKBACK_YEARS,
  type TelehealthModality,
  type VisitType,
  type VisitTypeHint,
  type VisitView,
} from "@/lib/features/visits/visit.types";
import {
  intakeTelehealthConsentFor,
  type PatientView,
} from "@/lib/features/patients/patient.types";

type Doc = JSONContent | null;

/** One of the org's active visit types, as /api/settings/visit-types lists it. */
interface VisitTypeOption {
  slug: string;
  label: string;
  codingBasis: VisitType;
  isTelehealth: boolean;
}

/** The home E/M codes: the base code among a signed visit's codes. */
const HOME_EM_CODES = new Set<string>([...NEW_PATIENT_HOME_CODES, ...ESTABLISHED_PATIENT_HOME_CODES]);

export default function VisitDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [visit, setVisit] = useState<VisitView | null>(null);
  const [patient, setPatient] = useState<PatientView | null>(null);
  const [payerCategory, setPayerCategory] = useState<"medicare" | "non_medicare">("non_medicare");
  const [loading, setLoading] = useState(true);
  // loadError kills the page (visit unfetchable); error renders inline so a
  // failed save/submit doesn't unmount the editor and eat unsaved work.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Local form state
  const [doc, setDoc] = useState<Doc>(null);
  const [startTime, setStartTime] = useState<string>("");
  const [stopTime, setStopTime] = useState<string>("");
  const [acpMinutes, setAcpMinutes] = useState<number>(0);
  const [isTelehealth, setIsTelehealth] = useState(false);
  // Where the visit took place (audit R23). Prefilled from the telehealth box.
  const [placeOfService, setPlaceOfService] = useState("12");
  const [telehealthModality, setTelehealthModality] =
    useState<TelehealthModality>("audio_video");
  const [telehealthConsent, setTelehealthConsent] = useState(false);
  /**
   * Set when the patient's intake consent pre-ticked the box (audit R22): the
   * timestamp it was given, shown beside the box so the clinician can see
   * where the tick came from. Cleared once they set the box themselves.
   */
  const [consentFromIntake, setConsentFromIntake] = useState<string | null>(null);
  // Pricing tier is NOT chosen here. It follows from the rendering
  // clinician's credential on the Team page (audit R25) — this used to be a
  // per-visit dropdown that nothing read.
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /**
   * What happened to the draft bill when the visit was signed. Signing
   * succeeds either way; this is what stops a failed draft reading as a
   * submitted claim.
   */
  const [billNotice, setBillNotice] = useState<
    | { kind: "created"; superbillId: string }
    | { kind: "missing"; reason: string }
    // A "Not billed" visit type (audit R18): signed, and no bill is due.
    | { kind: "not_billed" }
    | null
  >(null);
  /**
   * Persists any note section typed into but not yet blurred. Signing locks the
   * note, so a paragraph still sitting unsaved in the editor when the clinician
   * clicks Sign would be lost permanently.
   */
  const flushNote = useRef<(() => Promise<boolean>) | null>(null);
  /** CPT time ladders from code.typical_minutes. Null until loaded. */
  const [bands, setBands] = useState<VisitCodeBands | null>(null);
  /**
   * The ladders could not be fetched, so nothing can be suggested. Tracked
   * separately from `bands === null`, which is also the state before the fetch
   * returns: without it the Suggested codes card simply never appeared, which
   * looks exactly like a visit nobody has coded yet, and the only other word
   * the clinician got was "Need at least one CPT code before submitting" on
   * clicking Sign, with nothing on screen joining the two.
   */
  const [bandsUnavailable, setBandsUnavailable] = useState(false);
  /** Whether this user may download the PDF packet — the route needs billing.*. */
  const [canExportPacket, setCanExportPacket] = useState(false);
  /** May load the per-visit bill page (billing.superbills.view). */
  const [canViewBill, setCanViewBill] = useState(false);
  /** May create a bill there too (view + billing.superbills.create). */
  const [canCreateBill, setCanCreateBill] = useState(false);
  /** May sign an addendum to the attested note (visits.submit) — audit R15. */
  const [canSignAddendum, setCanSignAddendum] = useState(false);
  /** Whoever may read the audit log gets a link to this visit's trail (audit R24). */
  const [canViewAudit, setCanViewAudit] = useState(false);
  /** This visit's diagnoses (ICD-10), first = primary. Saved with the visit. */
  const [diagnoses, setDiagnoses] = useState<string[]>([]);
  /** Note-vs-superbill findings. Null until loaded, [] when there is nothing to say. */
  const [findings, setFindings] = useState<PacketFinding[] | null>(null);
  /** Showing the rendered note instead of the editor. */
  const [preview, setPreview] = useState(false);
  /** Bumped on every toggle so the preview re-fetches rather than showing a cached render. */
  const [previewNonce, setPreviewNonce] = useState(0);
  /**
   * The Visit type card. The type decides the CPT band the visit is coded on,
   * and it used to appear only in the heading with nothing able to change it
   * after scheduling. The org's active types load only for someone who may
   * change it (visits.edit, what PATCH /visit-type enforces) on an open visit;
   * null otherwise, and the card shows the label alone.
   */
  const [visitTypes, setVisitTypes] = useState<VisitTypeOption[] | null>(null);
  const [canEditType, setCanEditType] = useState(false);
  /** Pallio's own history for this patient before this visit, the visit left out. */
  const [typeHint, setTypeHint] = useState<VisitTypeHint | null>(null);
  /** The type picked in the card, not yet applied. */
  const [typeChoice, setTypeChoice] = useState("");
  const [changingType, setChangingType] = useState(false);
  /**
   * Re-keys SectionedNote after a type change: which sections are required
   * follows the type and the telehealth flag, and the note loads that only
   * when it mounts.
   */
  const [noteKey, setNoteKey] = useState(0);
  /** The type just left forced telehealth, and the box is still ticked from it. */
  const [teleLeftOver, setTeleLeftOver] = useState(false);

  /**
   * Re-read the comparison. Called after any note write, because the whole
   * value of showing this to a clinician is that it moves while they can
   * still act on it.
   */
  const loadFindings = useCallback(async () => {
    try {
      const r = await fetch(`/api/visits/${id}/reconciliation`);
      const d = await r.json();
      if (d.success) setFindings(d.data.findings as PacketFinding[]);
    } catch {
      /* leave whatever was last shown rather than blanking the panel */
    }
  }, [id]);

  /**
   * What Pallio's own history says about this patient before this visit, with
   * the visit itself left out. A refusal or a failure leaves no hint rather
   * than a wrong one: it is advice, and the type stays the clinician's call.
   */
  const loadTypeHint = useCallback(async (v: VisitView) => {
    const q = new URLSearchParams({ excludeVisitId: v.id });
    const at = v.startTime ?? v.scheduledStart;
    if (at) q.set("at", at);
    try {
      const r = await fetch(`/api/patients/${v.patientId}/visit-type-hint?${q.toString()}`);
      const d = await r.json();
      setTypeHint(d.success ? (d.data as VisitTypeHint) : null);
    } catch {
      setTypeHint(null);
    }
  }, []);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch(`/api/visits/${id}`);
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setLoadError(data.error ?? "Visit not found.");
          return;
        }
        const v = data.data as VisitView;
        // Whether the Visit type card below may offer a change; set from the
        // signed-in user's permissions further down.
        let mayChangeType = false;
        setVisit(v);
        setTypeChoice(v.visitType);
        setStartTime(toLocalDatetime(v.startTime));
        setStopTime(toLocalDatetime(v.stopTime));
        setAcpMinutes(v.acpMinutes ?? 0);
        // A telehealth visit type forces the box on (audit R22) and the server
        // refuses to clear it, so the screen starts from the same fact.
        const tele = v.isTelehealth || v.visitTypeIsTelehealth;
        setIsTelehealth(tele);
        setPlaceOfService(v.placeOfServiceCode ?? defaultPosFor(tele));
        setTelehealthModality(v.telehealthModality ?? "audio_video");
        setTelehealthConsent(v.telehealthConsentDocumented);
        // Set again below only if this visit takes the intake consent.
        setConsentFromIntake(null);
        setDoc(parseDoc(v.documentText));
        setDiagnoses(v.icd10Codes ?? []);
        // The CPT time ladders. Reference data, so this is the same for every
        // org and every visit — but it must arrive before any code is
        // suggested, which is why `suggestion` stays null until it does.
        try {
          const br = await fetch("/api/billing/code-bands");
          const bd = await br.json();
          // A refused request and a thrown one are the same to the clinician,
          // so both raise the flag the panel reads.
          if (!abandoned) {
            if (bd.success) setBands(bd.data as VisitCodeBands);
            else setBandsUnavailable(true);
          }
        } catch {
          /* leave bands null — the panel says codes are unavailable rather
             than falling back to numbers baked into the client */
          if (!abandoned) setBandsUnavailable(true);
        }
        // Does this user hold the billing grant the PDF route enforces? The
        // button is hidden rather than left to 403.
        try {
          const mr = await fetch("/api/auth/me");
          const md = await mr.json();
          if (md.success && !abandoned) {
            const perms: string[] = md.data?.permissions ?? [];
            // PATCH /visit-type needs visits.edit. A billing agent holds
            // visits.view.all without it, and would get a control that 403s.
            mayChangeType = perms.includes("visits.edit");
            setCanEditType(mayChangeType);
            setCanSignAddendum(perms.includes("visits.submit"));
            setCanViewAudit(perms.includes("audit.view"));
            setCanExportPacket(
              perms.includes("billing.superbills.export") ||
                md.data?.role === "platform_admin",
            );
            // Mirror what the routes enforce: loading the bill page needs
            // .view, and creating a bill from it needs .create as well.
            // Clinicians sign visits but hold neither, so a link for them
            // would be a 403 dressed up as an action.
            const admin = md.data?.role === "platform_admin";
            const view = perms.includes("billing.superbills.view");
            setCanViewBill(view || admin);
            setCanCreateBill((view && perms.includes("billing.superbills.create")) || admin);
          }
        } catch {
          /* leave the button hidden — a hidden button is a better failure
             than one that 403s */
        }
        if (!abandoned) void loadFindings();
        // Fetch patient in parallel (don't block render on it).
        try {
          const pr = await fetch(`/api/patients/${v.patientId}`);
          const pd = await pr.json();
          if (pd.success && !abandoned) {
            const p = pd.data as PatientView;
            setPatient(p);
            // Consent given at intake pre-ticks this visit's acknowledgment
            // (audit R22), on an open telehealth visit that has not recorded
            // one. The tick is saved as the visit's own flag, which the server
            // still requires at sign-off; a signed visit shows only what was
            // attested.
            const intakeConsent = intakeTelehealthConsentFor(v, p);
            if (intakeConsent) {
              setTelehealthConsent(true);
              setConsentFromIntake(intakeConsent);
            }
            // The primary payer's category picks G0318 (Medicare) vs 99417
            // (non-Medicare) for prolonged service. It is read off the
            // patient's own payer (audit R17), not found in the payer list:
            // that list is active-only, so a withdrawn Medicare Advantage plan
            // dropped out of it and its patients were offered 99417, which the
            // plan denies.
            setPayerCategory(
              p.primaryPayerType?.startsWith("medicare") ? "medicare" : "non_medicare",
            );
          }
        } catch {
          /* non-fatal — sidebar shows a hint to set payer on patient record */
        }
        // The Visit type card: the org's active types and what Pallio has on
        // this patient's earlier visits. Only for someone who may change the
        // type, on a visit still open: the hint is a read of the patient's
        // history, logged as PHI access, and a signed visit's type is attested.
        // Neither blocks the page.
        if (!abandoned && mayChangeType && (v.status === "scheduled" || v.status === "in_progress")) {
          void fetch("/api/settings/visit-types")
            .then((r) => r.json())
            .then((td) => {
              if (!abandoned && td.success) setVisitTypes((td.data?.types ?? []) as VisitTypeOption[]);
            })
            .catch(() => {
              /* the card shows the label alone */
            });
          void loadTypeHint(v);
        }
      } catch {
        if (!abandoned) setLoadError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
    // loadFindings is a useCallback keyed on id, so listing it re-runs this
    // effect exactly when id changes — the same as before, now declared.
    // loadTypeHint has no dependencies, so it never re-runs it.
  }, [id, loadFindings, loadTypeHint]);

  // Live total minutes from start/stop. Falls back to whatever the user
  // typed manually (rare).
  const totalMinutes = useMemo(() => {
    const start = startTime ? new Date(startTime) : null;
    const stop = stopTime ? new Date(stopTime) : null;
    return computeTotalMinutes(start, stop) ?? visit?.totalMinutes ?? 0;
  }, [startTime, stopTime, visit?.totalMinutes]);

  const payerProlongedCode = patient?.primaryPayerProlongedCode ?? null;

  // Live CPT suggestion — pure, client-side.
  const suggestion = useMemo(() => {
    if (!visit) return null;
    // No ladder, no suggestion. The time bands come from code.typical_minutes
    // via /api/billing/code-bands; suggesting a billable code from a fallback
    // baked into the client is exactly the drift this replaced.
    if (!bands) return null;
    // The suggester picks G0318 (Medicare) vs 99417 (non-Medicare) for
    // prolonged service based on payer category, resolved from the
    // patient's primary payer (medicare_mac / medicare_advantage_org) —
    // unless the payer's own record names the code it takes (0108), as an
    // Ohio Medicaid managed-care plan that takes G0318 does.
    return suggestCodes({
      bands,
      // codingBasis, never the raw slug: an org's custom type ("Bereavement
      // follow-up") would fall through the suggester's switch and code nothing.
      visitType: visit.codingBasis,
      totalMinutes,
      acpMinutes,
      payerCategory,
      prolongedServiceCode: payerProlongedCode ?? undefined,
      isTelehealth,
      telehealthModality,
    });
  }, [visit, bands, totalMinutes, acpMinutes, payerCategory, payerProlongedCode, isTelehealth, telehealthModality]);

  // Signed = attested. Past this point the note is frozen and the server
  // rejects edits; the UI has to agree with it.
  const locked =
    visit !== null &&
    (["documented", "pending_billing", "billed"] as const).includes(
      visit.status as "documented" | "pending_billing" | "billed",
    );

  // More ACP minutes than the visit lasted: said beside the input, and Sign
  // refuses it, as the server does. Not on a signed visit, whose times can no
  // longer be corrected here.
  const acpProblem = locked ? null : acpOverTotalProblem(acpMinutes, totalMinutes);

  // A "Not billed" visit type (audit R18) is signed and stops there: nothing
  // is coded, no bill is drafted, and the server refuses to move it to
  // billing. Read from the visit, not the suggestion, which waits on the code
  // ladders loading; signing this visit must not.
  const nonBillable = visit?.codingBasis === "non_billable";

  // The Visit type card offers a change only on an open visit, to someone with
  // visits.edit — changeVisitType refuses everything else — and says when
  // Pallio's history disagrees with the band the type bills on.
  const typeEditable =
    canEditType && (visit?.status === "scheduled" || visit?.status === "in_progress");
  const typeWarning = visit ? visitTypeHistoryWarning(visit.codingBasis, typeHint) : null;

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;
  if (loadError || !visit)
    return (
      <div className="px-8 py-8">
        <p className="text-red-700">{loadError ?? "Visit not found."}</p>
        <Link
          href="/visits"
          className="mt-4 inline-block text-[var(--color-brand-700)] underline"
        >
          ← Back to visits
        </Link>
      </div>
    );

  /** @returns true iff the PATCH persisted — callers must not proceed on false. */
  async function save(): Promise<boolean> {
    // The server refuses edits to a signed visit; don't let autosave-on-blur
    // keep firing against it and painting an error over a read-only note.
    if (locked) return false;
    setSaving(true);
    setError(null);
    try {
      // The codes and the units of any add-on that carries more than one, as
      // one assignment (0106): the suggester counted G0318/99417/99498 units,
      // but this used to save `.code` alone, so every add-on billed once.
      // With no suggestion it falls back to what the visit holds, units
      // included — documentVisit writes cpt_units with a COALESCE, and
      // '{}'::jsonb is a value, not a NULL, so an empty map would wipe them.
      const assignment = suggestion
        ? assignmentFromSuggestion(suggestion)
        : { codes: visit?.cptCodesAssigned ?? [], units: visit?.cptUnits ?? {} };
      // The same fallback as the codes above, and for the same reason. This
      // read `(suggestion?.modifiers ?? []).map(...)`, which with no suggestion
      // is an EMPTY array rather than no opinion — and documentVisit binds
      // `modifiers = COALESCE($1::text[], modifiers)`, where an empty array is
      // a value, not a NULL. So one "Save draft" while the code ladders were
      // unavailable wiped the 95 off a telehealth visit while carefully
      // keeping its CPT codes.
      const allMods = suggestion
        ? suggestion.modifiers.map((m) => m.modifier)
        : (visit?.modifiers ?? []);

      const body = {
        startTime: startTime ? new Date(startTime).toISOString() : undefined,
        stopTime: stopTime ? new Date(stopTime).toISOString() : undefined,
        totalMinutes,
        acpMinutes,
        // documentText is deliberately NOT sent. The note now lives in
        // visit_note_section, written by SectionedNote. This screen used to
        // send JSON.stringify(doc ?? emptyDoc) on every save, and because the
        // UPDATE COALESCEs the incoming value, that would have overwritten a
        // legacy visit's entire note with an empty document the first time
        // anyone opened it.
        cptCodesAssigned: assignment.codes,
        cptUnits: assignment.units,
        modifiers: allMods,
        // The visit's own diagnoses (audit R13). Without these the bill fell
        // back to the patient's intake diagnosis, or to none.
        icd10Codes: diagnoses,
        isTelehealth,
        telehealthModality: isTelehealth ? telehealthModality : undefined,
        telehealthConsentDocumented: telehealthConsent,
        placeOfServiceCode: placeOfService,
        // The type these codes were worked out for. If it was changed since
        // this screen loaded the visit — another tab, an admin correcting it —
        // the server refuses the save rather than write the old band's codes.
        visitType: visit?.visitType,
      };
      const r = await fetch(`/api/visits/${id}/document`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        return false;
      }
      setSaved(new Date().toLocaleTimeString());
      // The diagnosis, codes and telehealth fields this saves are what the
      // payer documentation finding reads (audit R19); refresh the card.
      void loadFindings();
      return true;
    } catch {
      setError("Network error.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitForBilling() {
    // Said before the missing-code line: with the minutes in conflict nothing
    // is coded, and "need a code" would send the clinician the wrong way.
    if (acpProblem) {
      setError(acpProblem);
      return;
    }
    // A "Not billed" visit has no codes by design (audit R18); only a billable
    // one needs a code before it is signed.
    if (!nonBillable && (!suggestion || suggestion.inconclusive)) {
      setError("Need at least one CPT code before submitting.");
      return;
    }
    if (isTelehealth && !telehealthConsent) {
      setError("Telehealth visit needs consent acknowledgment.");
      return;
    }
    setSubmitting(true);
    try {
      // Flush the note FIRST. Sections autosave on blur, and clicking this
      // button does not reliably blur the editor the clinician was typing in —
      // verified on localhost, where a paragraph typed and then signed was lost
      // and could not be recovered because signing locks the note.
      // If any section failed to persist, STOP. The note locks on sign, so
      // continuing here is the data loss flush() exists to prevent — the
      // section reports its own error, but only this caller can decline to
      // sign on top of it.
      if ((await flushNote.current?.()) === false) {
        setError(
          "A section of the note could not be saved, so the visit was not signed. Signing locks the note — resolve that first.",
        );
        return;
      }
      // A failed save must block the sign-off — otherwise the visit
      // transitions to billing with stale/unsaved documentation.
      if (!(await save())) return;
      const t1 = await fetch(`/api/visits/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "documented" }),
      });
      // Surface the server's actual message. Swallowing it turned a missing
      // permission into an opaque "transition failed" with nothing to act on.
      const d1 = await t1.json();
      if (!d1.success) {
        setError(d1.error ?? "Could not sign the visit.");
        return;
      }
      if (nonBillable) {
        // Signed is where a "Not billed" visit rests (audit R18): no move to
        // pending_billing, which the server refuses for it, and no bill.
        setVisit((v) => (v ? { ...v, status: "documented" } : v));
        try {
          const fresh = await fetch(`/api/visits/${id}`).then((r) => r.json());
          if (fresh.success) setVisit(fresh.data as VisitView);
        } catch {
          /* the status flip above has already locked the screen */
        }
        setSaved(`Signed ${new Date().toLocaleTimeString()}`);
        setBillNotice({ kind: "not_billed" });
        void loadFindings();
        return;
      }
      const t2 = await fetch(`/api/visits/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "pending_billing" }),
      });
      const data = await t2.json();
      if (!data.success) {
        setError(data.error ?? "Transition failed.");
        return;
      }
      // Reflect the new status locally so the note locks immediately rather
      // than only after a reload.
      setVisit((v) => (v ? { ...v, status: "pending_billing" } : v));
      // Pick up who signed and under which credential (audit R32). The local
      // status flip above cannot know them, so the lock banner said only
      // "Signed" until a reload.
      try {
        const fresh = await fetch(`/api/visits/${id}`).then((r) => r.json());
        if (fresh.success) setVisit(fresh.data as VisitView);
      } catch {
        /* the status flip above has already locked the screen */
      }
      setSaved(`Submitted ${new Date().toLocaleTimeString()}`);
      // Say what happened to the bill. The visit is signed either way, but a
      // failed draft used to sit under "Submitted" looking exactly like a
      // claim on its way to the payer.
      const billId: string | null = data.data?.superbillId ?? null;
      setBillNotice(
        billId
          ? { kind: "created", superbillId: billId }
          : {
              kind: "missing",
              reason: data.data?.autoDraftError ?? "No draft bill was created.",
            },
      );
      // The "Note against bill" panel was loaded before signing, when no bill
      // existed. Reload it so it compares the note with the bill just made
      // instead of still reading "No bill yet".
      void loadFindings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Correct the visit type before signing (PATCH /visit-type). The note is
   * flushed first and re-mounted after, since its required sections follow the
   * type. The change is put on screen from the PATCH's own answer, and only the
   * visit is re-read after it, so unsaved Start, Stop and ACP minutes survive
   * it and the suggestion re-runs on them.
   */
  async function changeType() {
    if (!visit || changingType || typeChoice === visit.visitType) return;
    const target = visitTypes?.find((t) => t.slug === typeChoice);
    if (!target) return;
    const bandChanges = target.codingBasis !== visit.codingBasis;
    if (
      !window.confirm(
        `Changing the visit type re-runs the code suggestion${
          bandChanges ? " and clears the codes already saved for this visit" : ""
        }.`,
      )
    ) {
      return;
    }
    setChangingType(true);
    setError(null);
    try {
      // The same rule as signing: a section that failed to save stops here,
      // because the re-mount below would drop what is still in the editor.
      if ((await flushNote.current?.()) === false) {
        setError(
          "A section of the note could not be saved, so the visit type was not changed. Resolve that first.",
        );
        return;
      }
      const r = await fetch(`/api/visits/${id}/visit-type`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitType: typeChoice }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not change the visit type.");
        return;
      }
      // The type HAS changed. Put it on screen from the PATCH's answer and the
      // type chosen, not from a second request: when a reload after the change
      // failed, the screen stayed on the old type, and its next save wrote the
      // old band's codes back over the ones the change had cleared. What the
      // server wrote is known — the slug, the band, telehealth forced on by a
      // telehealth type, the codes cleared when the band moved.
      const done = d.data as { codesCleared?: boolean; toBasis?: VisitType };
      const leftForcedType = visit.visitTypeIsTelehealth;
      const next: VisitView = {
        ...visit,
        visitType: target.slug,
        visitTypeLabel: target.label,
        codingBasis: done.toBasis ?? target.codingBasis,
        visitTypeIsTelehealth: target.isTelehealth,
        isTelehealth: visit.isTelehealth || target.isTelehealth,
        telehealthModality: visit.telehealthModality ?? (target.isTelehealth ? "audio_video" : null),
        ...(done.codesCleared ? { cptCodesAssigned: [], cptUnits: {} } : {}),
      };
      setVisit(next);
      setTypeChoice(next.visitType);
      if (next.visitTypeIsTelehealth) {
        // The new type forces telehealth and the server has set the flag, so
        // the box follows it — or the next save would send it unticked and be
        // refused — and the place of service with it while it still holds the
        // in-person default.
        setIsTelehealth(true);
        setPlaceOfService((pos) => (pos === defaultPosFor(false) ? defaultPosFor(true) : pos));
        setTeleLeftOver(false);
      } else {
        // Never unticked for them: whether this visit was in person is the
        // clinician's to say. Said out loud instead.
        setTeleLeftOver(leftForcedType && isTelehealth);
      }
      setNoteKey((k) => k + 1);
      void loadFindings();
      void loadTypeHint(next);
      // Then the server's own copy. Best effort: the change is already on
      // screen, so a failed reload has nothing to undo.
      try {
        const fresh = await fetch(`/api/visits/${id}`).then((res) => res.json());
        if (fresh.success) {
          setVisit(fresh.data as VisitView);
          setTypeChoice((fresh.data as VisitView).visitType);
        }
      } catch {
        /* the screen already shows the new type */
      }
    } catch {
      // No answer to the PATCH, so whether the type changed is not known. If
      // it did, the next save is refused rather than write the old codes.
      setError("Network error. Reload the page to see which type this visit has now.");
    } finally {
      setChangingType(false);
    }
  }

  return (
    <div className="px-8 py-6 max-w-5xl">
      <header className="mb-5">
        <Link
          href={`/patients/${visit.patientId}`}
          className="text-xs text-slate-500 hover:underline"
        >
          ← Patient
        </Link>
        <h1 className="font-display text-2xl tracking-tight mt-1">
          Document visit · {visit.visitTypeLabel}
        </h1>
        <p className="text-slate-600 mt-1 tabular text-sm">
          {visit.status} · {totalMinutes} min documented
        </p>
        {/* Whose note this is, on the screen that attests it (audit R32). */}
        {patient && (
          <p className="text-slate-500 mt-0.5 text-xs tabular">
            {patient.lastName}, {patient.firstName} · DOB {patient.dateOfBirth} · Member ID{" "}
            {patient.primaryMemberId ?? "—"}
          </p>
        )}
      </header>

      <MedicareWindowBanner visit={visit} />

      {/*
        What happened to the draft bill raised at sign-off. Signing succeeds
        either way; this is what keeps a failed draft from reading as a
        submitted claim. It covers the signing that just happened — on a later
        load, the "Note against bill" panel reports the missing bill instead.
      */}
      {billNotice?.kind === "missing" && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span>
            <strong>Signed, but no bill was drafted.</strong> {billNotice.reason} The visit
            is waiting in billing with no claim until a bill is created.
          </span>
          {canCreateBill ? (
            <Link
              href={`/visits/${id}/superbill`}
              className="shrink-0 rounded-md bg-white px-3 py-1.5 text-xs font-medium ring-1 ring-inset ring-amber-400 hover:ring-amber-500"
            >
              Create the bill
            </Link>
          ) : (
            <span className="shrink-0 text-xs text-amber-900">Someone with billing access needs to create it.</span>
          )}
        </div>
      )}
      {billNotice?.kind === "not_billed" && (
        <div
          role="status"
          className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800"
        >
          Signed. This visit type isn&rsquo;t billed, so no bill was drafted.
        </div>
      )}
      {billNotice?.kind === "created" && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          <span>Signed and sent to billing. A draft bill was created for this visit.</span>
          {canViewBill && (
            <Link
              href={`/visits/${id}/superbill`}
              className="shrink-0 rounded-md bg-white px-3 py-1.5 text-xs font-medium ring-1 ring-inset ring-emerald-300 hover:ring-emerald-400"
            >
              Open the bill
            </Link>
          )}
        </div>
      )}

      {locked && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700 ring-1 ring-inset ring-slate-300">
          <span>
            Signed{visit.signerName ? ` by ${visit.signerName}` : ""}
            {visit.signerCredential ? `, ${visit.signerCredential}` : ""}
            {visit.signedAt ? ` on ${new Date(visit.signedAt).toLocaleString()}` : ""}
            {/* A Not billed visit type is signed and never submitted (audit R18). */}
            {nonBillable ? ". This visit type isn't billed" : " and submitted for billing"}. The
            documentation is locked — record any change as an addendum below.
          </span>
          {/*
            The artefact Mark asked for: "the audit tool that you need for each
            visit is that note and the superbill." Only offered once the visit is
            signed — before that there is no attested note to defend anything.

            Gated on the permission the route actually enforces. It used to
            render for everyone who could see a locked visit, so a clinician —
            who holds no billing.* grant — got a button whose only outcome was
            a 403 page with the PDF viewer pointed at it. The reconciliation
            itself is below and needs no billing permission.
          */}
          {canExportPacket && (
            <a
              href={`/api/visits/${id}/audit-packet`}
              className="shrink-0 rounded-md bg-white px-3 py-1.5 text-xs font-medium ring-1 ring-inset ring-slate-300 hover:ring-slate-400"
            >
              Download audit packet
            </a>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Documentation</CardTitle>
                  <CardDescription>
                    {preview
                      ? "The finished note, as an auditor would read it."
                      : "Each section auto-saves on blur. Required sections must be filled before the visit can be signed."}
                  </CardDescription>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    // Flush before previewing, or the preview renders the
                    // server's copy while the newest paragraph is still sitting
                    // unsaved in the editor — and the clinician reviews a note
                    // that is not the one they wrote.
                    if (!preview) await flushNote.current?.();
                    setPreviewNonce((n) => n + 1);
                    setPreview((p) => !p);
                  }}
                  className="shrink-0 rounded-md bg-white px-3 py-1.5 text-xs font-medium ring-1 ring-inset ring-slate-300 hover:ring-slate-400"
                >
                  {preview ? "Back to editing" : "Preview finished note"}
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {/*
                Preview is keyed on `previewNonce` so it re-renders from the
                server each time it is opened — a preview showing a stale note
                would be worse than none.
              */}
              {preview ? (
                <NotePreview key={previewNonce} visitId={id} />
              ) : (
                <SectionedNote
                  // A type change re-mounts it: its required sections follow
                  // the type, and it reads them only on mount.
                  key={noteKey}
                  visitId={id}
                  readOnly={locked}
                  onSaved={loadFindings}
                  registerFlush={(fn) => {
                    flushNote.current = fn;
                  }}
                />
              )}
            </CardContent>
          </Card>

          {/*
            The comparison Mark described as the thing agencies get wrong
            without realising [10:12-10:43]. On screen, not buried in a PDF:
            the clinician is the one who can still fix a disagreement, and
            they hold no billing permission, so the packet was invisible to
            exactly the person who needed it.
          */}
          {findings && findings.length > 0 && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Note against bill</CardTitle>
                <CardDescription>
                  What an auditor comparing this note with the claim would see.
                  {canViewAudit && (
                    <>
                      {" "}
                      <Link
                        href={`/audit?visitId=${id}`}
                        className="font-medium text-[var(--color-brand-700)] hover:underline"
                      >
                        Audit trail for this visit →
                      </Link>
                    </>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {findings.map((f, i) => (
                    <li key={`${f.label}:${i}`} className="flex gap-3 text-sm">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          f.severity === "mismatch"
                            ? "bg-red-600"
                            : f.severity === "attention"
                              ? "bg-amber-500"
                              : "bg-emerald-600"
                        }`}
                      />
                      <span>
                        <span className="font-medium text-slate-800">{f.label}</span>
                        <span className="sr-only">{` — ${f.severity}`}</span>
                        <span className="text-slate-600">{` — ${f.detail}`}</span>
                        {f.action === "create_superbill" &&
                          (canCreateBill ? (
                            <>
                              {" "}
                              <Link
                                href={`/visits/${id}/superbill`}
                                className="font-medium text-[var(--color-brand-700)] hover:underline"
                              >
                                Create the bill →
                              </Link>
                            </>
                          ) : (
                            <span className="text-slate-600"> Someone with billing access needs to create it.</span>
                          ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/*
            Visits documented before the structured note existed hold their
            whole note in one free-text column. Show it, read-only, rather than
            hiding it — it is the attested record for those visits — and never
            write to it from this screen again.
          */}
          {doc && (
            <Card>
              <CardHeader>
                <CardTitle>Earlier note</CardTitle>
                <CardDescription>
                  Written before this org moved to the structured note. Read-only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TipTapEditor initial={doc} readOnly />
              </CardContent>
            </Card>
          )}

          {/* Corrections to the attested note (audit R15). */}
          {locked && <VisitAddenda visitId={id} canSign={canSignAddendum} />}
          <VisitServicesPanel visitId={id} visitType={visit.visitType} readOnly={locked} />
        </div>

        <aside className="space-y-4">
          {/*
            The visit type decides the CPT band this visit is coded on. It was
            shown only in the heading and nothing could change it after
            scheduling, so a first visit booked on the established default
            reached the bill on the established ladder. Changeable here until
            the visit is signed; everyone else sees the label.
          */}
          <Card>
            <CardHeader>
              <CardTitle>Visit type</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {typeEditable && visitTypes ? (
                <>
                  <label className="block">
                    <span className="text-slate-700 font-medium">Visit type</span>
                    <select
                      value={typeChoice}
                      onChange={(e) => setTypeChoice(e.target.value)}
                      disabled={changingType}
                      className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
                    >
                      {/* A type switched off since this visit was booked is
                          still this visit's own. Listed, so the select does not
                          quietly show a different type. */}
                      {!visitTypes.some((t) => t.slug === visit.visitType) && (
                        <option value={visit.visitType} disabled>
                          {visit.visitTypeLabel}
                        </option>
                      )}
                      {visitTypes.map((t) => (
                        <option key={t.slug} value={t.slug}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={changeType}
                    loading={changingType}
                    disabled={changingType || typeChoice === visit.visitType}
                  >
                    Change visit type
                  </Button>
                  {/* Advice from Pallio's own history, which cannot see visits
                      from before the practice used it. */}
                  {typeWarning && typeHint && (
                    <p className="text-xs text-amber-900 bg-amber-50 px-2 py-2 rounded">
                      {typeWarningLine(typeWarning, typeHint)}
                    </p>
                  )}
                </>
              ) : (
                <p className="font-medium text-slate-800">{visit.visitTypeLabel}</p>
              )}
              {teleLeftOver && isTelehealth && (
                <p className="text-xs text-amber-900 bg-amber-50 px-2 py-2 rounded">
                  Telehealth is still ticked from the previous type — untick it if this visit was
                  in person.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Time</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {/* Disabled once signed, like every other field of the attested
                  record: these stayed editable, and the codes card re-ran on
                  whatever was typed into them. */}
              <label className="block">
                <span className="text-slate-700 font-medium">Start</span>
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={locked}
                  className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-base disabled:bg-slate-50 disabled:text-slate-600"
                />
              </label>
              <label className="block">
                <span className="text-slate-700 font-medium">Stop</span>
                <input
                  type="datetime-local"
                  value={stopTime}
                  onChange={(e) => setStopTime(e.target.value)}
                  disabled={locked}
                  className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-base disabled:bg-slate-50 disabled:text-slate-600"
                />
              </label>
              <p className="text-2xl font-bold tabular">
                {totalMinutes} <span className="text-sm text-slate-500 font-normal">min</span>
              </p>
              <label className="block">
                <span className="text-slate-700 font-medium">ACP minutes</span>
                <input
                  type="number"
                  min={0}
                  max={180}
                  value={acpMinutes}
                  onChange={(e) => setAcpMinutes(Number(e.target.value))}
                  disabled={locked}
                  aria-invalid={acpProblem ? true : undefined}
                  aria-describedby={acpProblem ? "acp-over-total" : undefined}
                  className="mt-1 w-24 h-9 px-2 border border-slate-300 rounded-md text-base tabular disabled:bg-slate-50 disabled:text-slate-600"
                />
              </label>
              {acpProblem && (
                <p id="acp-over-total" role="alert" className="text-xs text-red-700">
                  {acpProblem}
                </p>
              )}
              <p className="text-xs text-slate-500">
                The rate is set by the rendering clinician&apos;s credential on the
                Team page, not chosen per visit.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Where the visit took place</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <label className="block">
                <span className="text-slate-700 font-medium">Place of service</span>
                <select
                  value={placeOfService}
                  onChange={(e) => setPlaceOfService(e.target.value)}
                  disabled={locked}
                  className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
                >
                  {VISIT_POS_OPTIONS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.code} · {o.label}
                    </option>
                  ))}
                </select>
                <span className="block text-xs text-slate-500 mt-1">
                  Goes on the claim. Change it for an assisted-living, nursing-facility
                  or hospice visit.
                </span>
              </label>
              {posTelehealthConflict(placeOfService, isTelehealth) && (
                <p role="alert" className="text-xs text-red-700">
                  {posTelehealthConflict(placeOfService, isTelehealth)}
                </p>
              )}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isTelehealth}
                  // The visit type forces telehealth (audit R22); the server
                  // refuses to clear it, so the box is not offered. Nor on a
                  // signed visit, where the codes card would re-run on it.
                  disabled={locked || visit.visitTypeIsTelehealth}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setIsTelehealth(on);
                    // Keep the place of service in step with the box only
                    // while it still holds the other default.
                    setPlaceOfService((pos) =>
                      pos === defaultPosFor(!on) ? defaultPosFor(on) : pos,
                    );
                  }}
                />
                <span>This is a telehealth visit</span>
                {visit.visitTypeIsTelehealth && (
                  <span className="text-xs text-slate-500">Set by the visit type</span>
                )}
              </label>
              {isTelehealth && (
                <>
                  <label className="block">
                    <span className="text-slate-700 font-medium">Modality</span>
                    <select
                      value={telehealthModality}
                      onChange={(e) =>
                        setTelehealthModality(
                          e.target.value as TelehealthModality,
                        )
                      }
                      disabled={locked}
                      className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
                    >
                      <option value="audio_video">Audio + video (95 modifier)</option>
                      <option value="audio_only">Audio only (93 modifier)</option>
                    </select>
                  </label>
                  <label className="flex items-start gap-2 px-2 py-2 bg-amber-50 rounded-md ring-1 ring-inset ring-amber-600/30">
                    <input
                      type="checkbox"
                      checked={telehealthConsent}
                      onChange={(e) => {
                        setTelehealthConsent(e.target.checked);
                        // The clinician has now answered for this visit, so
                        // the intake note no longer explains the box.
                        setConsentFromIntake(null);
                      }}
                      disabled={locked}
                      className="mt-0.5"
                    />
                    <span className="text-amber-900 text-xs">
                      Patient consents to a telehealth visit. Required documentation per pallio §5.2.
                      {consentFromIntake && (
                        <span className="block mt-0.5 text-amber-800">
                          Consent on file from intake (
                          {new Date(consentFromIntake).toLocaleDateString()})
                        </span>
                      )}
                    </span>
                  </label>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Diagnosis</CardTitle>
              {/* The requirement is R13's — every signed encounter must say
                  what it addressed — not the bill's. This used to justify it
                  by the bill, which on a "Not billed" visit type is a bill
                  that never gets built, as the card two below says outright. */}
              <CardDescription>
                What this visit addressed, in ICD-10. At least one is required to
                sign: a signed encounter has to say what it was for. On a billed
                visit it is also what the claim carries.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DiagnosisPicker
                value={diagnoses}
                onChange={setDiagnoses}
                readOnly={locked}
                intakeDiagnosis={patient?.primaryDiagnosisIcd10 ?? null}
              />
            </CardContent>
          </Card>

          {/*
            A signed visit shows the codes it was signed with, read from the
            visit. The live suggestion used to stay here, re-run on whatever
            the screen held, so a visit signed with one G0318 unit showed
            G0318 ×3, and typing into its ACP minutes added 99497 to codes
            nobody had attested. The ladders and the patient's payer can
            change after signing too. Only an open visit gets the suggestion,
            and with it the "codes are unavailable" message, which is
            addressed to someone who has not signed yet.
          */}
          {locked && (
            <Card>
              <CardHeader>
                <CardTitle>Signed codes</CardTitle>
                <CardDescription>
                  What this visit was signed with.
                  {/* A Not billed visit has no bill to correct them on (audit R18). */}
                  {!nonBillable && " After signing, codes are corrected on the bill."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {nonBillable ? (
                  <p className="text-xs text-slate-700 bg-slate-50 px-2 py-2 rounded">
                    <strong>Not billed.</strong> This visit type is set not to bill, so it
                    was signed with no codes.
                  </p>
                ) : visit.cptCodesAssigned.length === 0 ? (
                  <p className="text-xs text-slate-600">No codes were signed with this visit.</p>
                ) : (
                  <>
                    {visit.cptCodesAssigned.map((code) => (
                      <CodeRow
                        key={code}
                        code={code}
                        reason=""
                        confidence="confirmed"
                        units={visit.cptUnits[code] ?? 1}
                        kind={HOME_EM_CODES.has(code) ? "base" : "add"}
                      />
                    ))}
                    {visit.modifiers.map((m) => (
                      <div
                        key={m}
                        className="text-xs text-slate-600 px-2 py-1 bg-slate-50 rounded"
                      >
                        Modifier {m}
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>
          )}
          {(!locked && (suggestion || nonBillable || bandsUnavailable)) && (
            <Card>
              <CardHeader>
                <CardTitle>Suggested codes</CardTitle>
                <CardDescription>
                  Live from <code className="text-xs">cpt-suggester</code> per vision §18.8.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {/* A Not billed visit type codes nothing by design (audit R18). */}
                {nonBillable || suggestion?.nonBillable ? (
                  <p className="text-xs text-slate-700 bg-slate-50 px-2 py-2 rounded">
                    <strong>Not billed.</strong> This visit type is set not to bill, so no
                    codes are suggested and signing drafts no bill.
                  </p>
                ) : !suggestion ? (
                  /* Only reachable with bandsUnavailable, on an open visit:
                     say so, rather than dropping the card and leaving a failed
                     fetch looking like an uncoded visit. Sign will refuse this
                     visit until the ladders load, so the message says that
                     here. */
                  <p role="alert" className="text-xs text-amber-900 bg-amber-50 px-2 py-2 rounded">
                    <strong>Codes are unavailable.</strong> The CPT time ladders could not
                    be loaded, so nothing is suggested and this visit cannot be signed for
                    billing yet. Reload the page; if it keeps failing, tell your
                    administrator before signing.
                  </p>
                ) : (
                  <>
                    {suggestion.base.map((c) => (
                      <CodeRow key={c.code} {...c} />
                    ))}
                    {suggestion.prolongedAddOns.map((c) => (
                      <CodeRow key={c.code} {...c} kind="add" />
                    ))}
                    {suggestion.acpAddOns.map((c) => (
                      <CodeRow key={c.code} {...c} kind="add" />
                    ))}
                    {suggestion.modifiers.map((m) => (
                      <div
                        key={m.modifier}
                        className="text-xs text-slate-600 px-2 py-1 bg-slate-50 rounded"
                      >
                        Modifier {m.modifier}: {m.reason}
                      </div>
                    ))}
                    {suggestion.acpOverTotal ? (
                      <p className="text-xs text-amber-800 bg-amber-50 px-2 py-2 rounded">
                        <strong>Nothing is coded.</strong> {suggestion.acpOverTotal}
                      </p>
                    ) : (
                      suggestion.inconclusive && (
                        <p className="text-xs text-amber-800 bg-amber-50 px-2 py-2 rounded">
                          No conclusive code yet — start the timer or pick a visit type.
                        </p>
                      )
                    )}
                    {/* The ACP-billed minutes came out of the E/M time and
                        took the base code with them; 99497 alone makes the
                        suggestion conclusive, so without this the missing
                        E/M code would go unsaid. */}
                    {suggestion.baseNote && (
                      <p className="text-xs text-amber-800 bg-amber-50 px-2 py-2 rounded">
                        {suggestion.baseNote}
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Payer rules</CardTitle>
              <CardDescription>
                Live from /v1/billing/lookup for the patient&rsquo;s payer.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RuleSidebar
                payerId={patient?.primaryPayerId}
                state={patient?.insuranceState ?? patient?.state}
                cptCodes={
                  // A signed visit's rules are its signed codes', as the card above.
                  locked
                    ? visit.cptCodesAssigned
                    : suggestion
                      ? Array.from(
                          new Set([
                            ...suggestion.base.map((c) => c.code),
                            ...suggestion.prolongedAddOns.map((c) => c.code),
                            ...suggestion.acpAddOns.map((c) => c.code),
                          ]),
                        )
                      : []
                }
                attribute={isTelehealth ? "telehealth" : "covered"}
              />
            </CardContent>
          </Card>
        </aside>
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500" aria-live="polite">
          {saving ? "Saving…" : saved ? saved : ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={save} loading={saving} disabled={locked}>
            Save draft
          </Button>
          <Button onClick={submitForBilling} loading={submitting} disabled={locked}>
            {/* Nothing goes to billing for a Not billed visit type (audit R18). */}
            {nonBillable ? "Sign" : "Sign + submit for billing"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CodeRow({
  code,
  reason,
  confidence,
  units = 1,
  kind = "base",
}: {
  code: string;
  reason: string;
  confidence: "edge" | "confirmed";
  /** How many of this code the save will bill (0106). */
  units?: number;
  kind?: "base" | "add";
}) {
  return (
    <div className="flex gap-2 items-start">
      <span
        className={`px-2 py-0.5 rounded text-xs font-mono font-semibold tabular ${
          kind === "base"
            ? "bg-[var(--color-brand-50)] text-[var(--color-brand-900)] ring-1 ring-inset ring-[var(--color-brand-600)]/30"
            : "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300"
        }`}
      >
        {code}
        {units > 1 && <span className="ml-1 font-normal">×{units}</span>}
      </span>
      <span className="text-xs text-slate-600 flex-1">
        {reason}
        {confidence === "edge" && (
          <span className="ml-1 text-amber-700">(confirm before submit)</span>
        )}
      </span>
    </div>
  );
}

function MedicareWindowBanner({ visit }: { visit: VisitView }) {
  const dosIso = visit.startTime ?? visit.scheduledStart;
  // A Not billed visit type has no claim to file, so no filing window (audit R18).
  if (!dosIso || visit.status === "billed" || visit.codingBasis === "non_billable") return null;
  const dos = new Date(dosIso);
  if (!isInsideMedicareWindow(dos)) {
    // Past the window — only relevant if visit isn't billed yet.
    if (visit.status === "documented" || visit.status === "pending_billing") {
      return (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-md bg-red-50 ring-1 ring-inset ring-red-600/20 text-sm text-red-800"
        >
          Outside the 11-day Medicare billing window (3 days before DOS + 7
          days after). Submit ASAP — claim may be denied for timely filing.
        </div>
      );
    }
    return null;
  }
  const remaining = daysRemainingInMedicareWindow(dos);
  if (remaining <= 2) {
    return (
      <div className="mb-4 px-3 py-2 rounded-md bg-amber-50 ring-1 ring-inset ring-amber-600/30 text-sm text-amber-900">
        Medicare 11-day billing window closes in{" "}
        <strong className="tabular">
          {remaining} day{remaining === 1 ? "" : "s"}
        </strong>
        . Sign + submit before the window closes.
      </div>
    );
  }
  return null;
}

/** The Visit type card's note when the type's band and Pallio's history disagree. */
function typeWarningLine(kind: "looks_new" | "looks_established", h: VisitTypeHint): string {
  if (kind === "looks_new" || !h.lastVisitAt) {
    return `Pallio has no visit for this patient in the ${NEW_PATIENT_LOOKBACK_YEARS} years before this visit. If your practice has not seen them in that time either, this is a New patient visit.`;
  }
  const on = new Date(h.lastVisitAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${h.lastVisitStatus === "scheduled" ? "Booked for" : "Seen on"} ${on}: payers treat a new-patient code within ${NEW_PATIENT_LOOKBACK_YEARS} years of a visit by this practice as established.`;
}

function toLocalDatetime(iso: string | null): string {
  if (!iso) return "";
  // datetime-local input format: YYYY-MM-DDTHH:MM
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDoc(text: string | null): Doc {
  if (!text) return null;
  try {
    return JSON.parse(text) as JSONContent;
  } catch {
    // Legacy plain-text — wrap as a single paragraph.
    return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  }
}

