/**
 * One line of readable detail per audit row (audit R24).
 *
 * The audit page showed When / User / Action / Target, and Target was an
 * eight-character id. The payload reached the browser and was never
 * rendered, so the note-to-claim pairing the log did record (every
 * superbill_create carries its visitId) was invisible, and an org admin
 * could not pull "the note and the superbill for each visit" from it.
 *
 * WHITELISTED, PER ACTION. Payloads carry ids, field names and counts, never
 * PHI (audit-write.ts). This prints only the keys named below for each
 * action; any other key is never printed, so a payload that one day grows a
 * field it should not carry does not reach the screen through here.
 */
import { VISIT_TYPES } from "@/lib/features/visits/visit.types";

export interface AuditSummary {
  /** One line; '' when there is nothing to add to the action itself. */
  text: string;
  /** The visit the row belongs to, when the row says; drives "Open visit". */
  visitId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const uuid = (v: unknown): string | null => {
  const s = str(v);
  return s && UUID_RE.test(s) ? s : null;
};
const words = (s: string) => s.replace(/_/g, " ");
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const join = (parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join(" · ");

// Contacts and outside providers (audit R30): only these column names and
// roles print, so a payload can never carry a name or number to the screen.
const CONTACT_FIELDS = new Set([
  "full_name", "relationship", "phone", "alt_phone", "email", "is_primary_caregiver",
  "is_emergency_contact", "is_healthcare_poa", "lives_with_patient", "notes",
]);
const PROVIDER_FIELDS = new Set(["full_name", "npi", "specialty", "practice_name", "phone", "fax"]);
const PROVIDER_ROLES: Record<string, string> = {
  primary_care: "primary care provider",
  referring: "referring physician",
  specialist: "specialist",
  other: "other",
};
const knownFields = (v: unknown, allowed: Set<string>) => list(v).filter((f) => allowed.has(f));

// A visit moved on the schedule: which of its two schedule columns changed,
// never the times themselves, which are a date of service.
const RESCHEDULE_FIELDS = new Set(["scheduled_start", "scheduled_end"]);

// A visit type change prints the CPT coding bands only: a closed set, so an
// org's own slug or label — free text — can never reach the screen through it.
const CODING_BANDS = new Set<string>(VISIT_TYPES);
const band = (v: unknown): string | null => (typeof v === "string" && CODING_BANDS.has(v) ? v : null);

// Org configuration (settings_update): what was changed, how, and which
// fields, each from a closed set. A visit type's or service's own name and a
// branding domain are the org's free text, so they never print.
const SETTINGS_TARGETS: Record<string, string> = {
  visit_type: "Visit type",
  visit_service: "Visit service",
  branding: "Branding",
  practice: "Practice settings",
  // 0121: the idle limit and who needs a second factor.
  security: "Security settings",
  // 0118: who the claims bill as, and the practice's own fees.
  billing_provider: "Billing provider",
  fee_schedule: "Fee",
};
const SETTINGS_CHANGES: Record<string, string> = {
  create: "added",
  edit: "edited",
  deactivate: "deactivated",
  reactivate: "reactivated",
  end: "ended",
};
const SETTINGS_FIELDS: Record<string, string> = {
  claimReferringProvider: "referring provider on claims",
  label: "name",
  name: "name",
  codingBasis: "bills like",
  isTelehealth: "telehealth",
  description: "description",
  category: "category",
  cptHint: "CPT hint",
  visitTypes: "visit types",
  displayName: "display name",
  logoUrl: "logo",
  primaryColor: "primary color",
  customDomain: "custom domain",
  emailFromName: "email sender name",
  emailFromAddress: "email sender address",
  timezone: "time zone",
  dailyVisitCapacity: "visits per clinician per day",
  idleTimeoutMinutes: "sign-out after inactivity",
  mfaPolicy: "who needs a second factor",
  legalName: "legal name",
  npi: "NPI",
  ein: "EIN",
  taxonomyCode: "taxonomy",
  address: "billing address",
  payTo: "pay-to address",
};

// Intake (0111). Referral columns, stages, verification methods and results
// are closed sets; a reason code prints by its number only, never its label.
const REFERRAL_FIELDS: Record<string, string> = {
  received_on: "received",
  first_name: "first name",
  last_name: "last name",
  date_of_birth: "date of birth",
  phone: "phone",
  source_name: "source",
  referring_provider_name: "referring provider",
  referring_provider_npi: "referring NPI",
  reason: "reason",
  primary_diagnosis_icd10: "diagnosis",
  payer_id: "insurance",
  member_id: "member ID",
  assigned_to_user_id: "assigned to",
  notes: "notes",
};
const REFERRAL_STAGES: Record<string, string> = {
  pre_admission: "pre-admission",
  pending_long_term: "pending long term",
  admitted: "admitted",
  ntuc: "not taken under care",
  transitioned: "transitioned",
};
const VERIFY_METHODS: Record<string, string> = {
  portal: "on the payer portal",
  phone: "by phone",
  clearinghouse: "through the clearinghouse",
  other: "another way",
};
const VERIFY_RESULTS: Record<string, string> = {
  active: "active",
  inactive: "inactive",
  not_found: "member not found",
  pending: "pending",
};
const REASON_CODE_FIELDS: Record<string, string> = {
  label: "label",
  category: "counts as",
  active: "in use",
  sortOrder: "order",
};
const reasonCode = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[0-9]{2}[a-z]?$/.test(s) ? s : null;
};
// Documents (0112): the kind is a closed set; the file's name is never logged.
const DOCUMENT_KINDS: Record<string, string> = {
  referral_order: "referral or order",
  medical_records: "medical records",
  face_sheet: "face sheet",
  insurance_card: "insurance card",
  consent: "signed consent",
  other: "other",
};
const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
};
// The chart's lists (0114): list, operation and field names are closed sets.
const CLINICAL_LISTS: Record<string, string> = {
  problems: "Problem list",
  medications: "Medication list",
  allergies: "Allergies",
};
const CLINICAL_OPS: Record<string, string> = {
  add: "added to",
  edit: "edited on",
  resolve: "resolved on",
  reopen: "reopened on",
  stop: "stopped on",
  restart: "restarted on",
  inactivate: "made inactive on",
  reactivate: "made active again on",
};
// The course of care (0115): closed sets.
const ACUITIES: Record<string, string> = { low: "low", medium: "medium", high: "high", critical: "critical" };
const EVENT_KINDS: Record<string, string> = {
  fall: "fall",
  ed_visit: "ED visit",
  hospital_admission: "hospital admission",
  other: "other significant event",
  hospice_discussion: "hospice discussion",
  hospice_referral: "hospice referral",
};
const EVENT_OPS: Record<string, string> = { add: "recorded", edit: "corrected", void: "voided as recorded in error" };
const HOSPICE_ENDS: Record<string, string> = {
  death: "died in hospice",
  live_discharge: "discharged alive from hospice",
  revocation: "revoked hospice",
  transfer: "transferred to another hospice",
};
// Care between visits (0116): closed sets.
const CARE_PLAN_PARTS: Record<string, string> = {
  document: "document",
  goalsOfCareSummary: "goals of care",
  primarySymptoms: "symptoms to monitor",
  goals: "goals",
  interventions: "interventions",
  monitoring: "monitoring",
  escalation: "escalation parameters",
  reviewOn: "review day",
};
const PROGRAMS: Record<string, string> = { pcm: "PCM", ccm: "CCM" };
const ESCALATION_MEASURES_TEXT: Record<string, string> = {
  pain: "pain",
  dyspnea: "shortness of breath",
  nausea: "nausea",
  pps: "PPS",
  spo2: "SpO2",
  fall: "fall",
  ed_visit: "ED visit",
  hospital_admission: "hospital admission",
};
const ALERT_OPS: Record<string, string> = {
  raise: "Escalation alert raised",
  withdraw: "Escalation alert withdrawn",
  acknowledge: "Escalation alert acknowledged",
};
const DISCIPLINES_TEXT: Record<string, string> = {
  np: "the NP",
  nursing: "nursing",
  social_work: "social work",
  chaplaincy: "chaplaincy",
  admin: "administration",
  other: "the team",
};
const TASK_OPS: Record<string, string> = { create: "created", edit: "changed", done: "done", cancel: "cancelled" };
// PCM/CCM (0117): closed sets.
const CM_ACTIVITIES_TEXT: Record<string, string> = {
  phone: "phone call",
  care_coordination: "care coordination",
  medication_management: "medication management",
  care_plan: "care plan work",
  caregiver_support: "caregiver support",
  other: "other",
};
const CM_KINDS: Record<string, string> = { qhp: "practitioner", clinical_staff: "clinical staff" };
// Clearinghouse rows (0120): closed sets only, so nothing typed ever prints.
const CLEARINGHOUSES: Record<string, string> = {
  availity: "Availity", waystar: "Waystar", trizetto: "TriZetto", inovalon: "Inovalon",
};
const CONNECTION_OPS: Record<string, string> = {
  create: "connection added", update: "connection edited", delete: "connection removed", test: "connection tested",
  disable: "connection switched off", enable: "connection switched on", reset_host_key: "host key reset",
  payer_ids: "payer IDs set",
};
const FILE_KINDS: Record<string, string> = {
  "999": "999 acknowledgment", ta1: "TA1 acknowledgment", "277ca": "277CA claim acknowledgment",
  "277": "277 claim status", "271": "271 eligibility answer", "835": "835 remittance",
  notification: "Clearinghouse notice", vendor_report: "Clearinghouse report", unknown: "Unrecognised file",
};
const CM_BASES: Record<string, string> = { staff: "clinical staff time", qhp: "the practitioner's own time" };
const CPT_RE = /^\d{5}$/;
const TASK_FIELDS: Record<string, string> = {
  title: "title",
  details: "details",
  discipline: "discipline",
  assigneeUserId: "assignee",
  dueOn: "due day",
};
const CLINICAL_FIELDS: Record<string, string> = {
  description: "description",
  onsetOn: "onset",
  notes: "notes",
  status: "status",
  resolvedOn: "resolved",
  name: "name",
  dose: "dose",
  route: "route",
  frequency: "frequency",
  prn: "as needed",
  indication: "indication",
  startedOn: "started",
  stoppedOn: "stopped",
  stopReason: "why stopped",
  substance: "substance",
  kind: "kind",
  reaction: "reaction",
  severity: "severity",
  inactiveReason: "why inactive",
};

export function summarizeAuditPayload(
  action: string,
  targetType: string | null,
  targetId: string | null,
  payload: Record<string, unknown> | null | undefined,
): AuditSummary {
  const p = payload ?? {};
  const onVisit = targetType === "visit" ? uuid(targetId) : null;
  const move = (): string | null => {
    const from = str(p.from);
    const to = str(p.to);
    return from && to ? `${words(from)} → ${words(to)}` : null;
  };

  switch (action) {
    case "superbill_create": {
      const codes = list(p.cptCodes);
      const billed = num(p.billedAmountCents);
      return {
        text: join(["Claim", codes.length > 0 && `CPT ${codes.join(", ")}`, billed !== null && money(billed)]),
        visitId: uuid(p.visitId),
      };
    }
    case "superbill_status_change": {
      const paid = num(p.paidAmountCents);
      // Another payment on a partially paid claim (D9): paid is then the total.
      const payment = num(p.paymentCents);
      const over = list(p.documentationOverride);
      // A remittance's step through submitted, which the documentation gate
      // records but does not stop (audit R10, R19). Element keys only: a value
      // that is not a snake_case key never prints.
      const gap = list(p.documentationGap).filter((e) => /^[a-z][a-z0-9_]*$/.test(e));
      // A payment the biller confirmed is above what the claim bills
      // (markStatusTx writes { billedAmountCents }). Without it this row read
      // "submitted → paid · paid $5000.00" — an ordinary payment — and /audit
      // is the screen an auditor reads to find exactly that. Read through
      // num(): a malformed field then prints nothing rather than asserting an
      // overpayment the payload does not establish, and only the amount is
      // taken, so a key this object one day grows never reaches the screen.
      const overBilled =
        typeof p.overpayment === "object" && p.overpayment !== null
          ? num((p.overpayment as Record<string, unknown>).billedAmountCents)
          : null;
      return {
        text: join([
          move(),
          payment !== null && `${p.lastPayment === true ? "last payment" : "another payment"} ${money(payment)}`,
          paid !== null && `paid ${money(paid)}${payment !== null ? " in all" : ""}`,
          overBilled !== null && `more than the ${money(overBilled)} billed, confirmed as an overpayment`,
          over.length > 0 && `submitted over a documentation gap (${over.map(words).join(", ")})`,
          gap.length > 0 && `documentation gap (${gap.map(words).join(", ")})`,
          // Posted from a payer's 835 rather than typed (audit R10).
          p.source === "remittance" && "per payer remittance",
          // Sent by Pallio, or answered by the clearinghouse's file (0120).
          p.source === "clearinghouse" &&
            (p.event === "sent"
              ? "sent through the clearinghouse"
              : p.event === "rejected"
                ? "rejected by the clearinghouse or payer"
                : "confirmed by the clearinghouse"),
        ]),
        visitId: uuid(p.visitId),
      };
    }
    case "denial_decision": {
      const d = str(p.decision);
      return { text: d ? `Decision: ${words(d)}` : "", visitId: uuid(p.visitId) };
    }
    case "denial_refile":
      return {
        text:
          p.claimAlreadyResent === true
            ? "Marked refiled · the claim had already gone back to the payer"
            : "Marked refiled · claim resubmitted",
        visitId: uuid(p.visitId),
      };
    case "denial_outcome": {
      const o = str(p.outcome);
      const amount = num(p.amountCents);
      // The same confirmed overpayment as the case above, one row down:
      // recordOutcome writes { deniedAmountCents } when the biller confirms a
      // recovery larger than the line the payer denied. Without it an
      // over-recovery read as an ordinary one on the screen an auditor opens
      // to find exactly that. Read through num() for the same reason: a
      // malformed field prints nothing rather than asserting an overpayment
      // the payload does not establish.
      const overDenied =
        typeof p.overpayment === "object" && p.overpayment !== null
          ? num((p.overpayment as Record<string, unknown>).deniedAmountCents)
          : null;
      return {
        text: join([
          o && `Outcome: ${words(o)}`,
          amount !== null && money(amount),
          overDenied !== null && `more than the ${money(overDenied)} denied, confirmed as an overpayment`,
          p.source === "remittance" && "per payer remittance",
        ]),
        visitId: uuid(p.visitId),
      };
    }
    case "remittance_post": {
      // One uploaded 835 (audit R10): how its claims posted, as counts.
      const claims = num(p.claims);
      const counted: [unknown, string][] = [
        [p.paid, "paid"],
        [p.partiallyPaid, "partially paid"],
        [p.denied, "denied"],
        [p.unmatched, "unmatched"],
        [p.needsReview, "held for review"],
        [p.errors, "failed"],
        [p.alreadyPosted, "already posted"],
      ];
      const posted = num(p.totalPaidCents);
      return {
        text: join([
          claims !== null && `835 · ${plural(claims, "claim")}`,
          ...counted.map(([v, label]) => {
            const n = num(v);
            return n !== null && n > 0 && `${n} ${label}`;
          }),
          posted !== null && posted > 0 && `${money(posted)} posted`,
        ]),
        visitId: null,
      };
    }
    case "visit_sign": {
      const cred = str(p.credential);
      return {
        text: join([
          move(),
          cred && `signed as ${cred}`,
          p.signerIsClinicianOfRecord === false && "not the clinician of record",
        ]),
        visitId: onVisit,
      };
    }
    case "visit_document":
      return { text: move() ?? "", visitId: onVisit };
    case "visit_cancel":
      return { text: join(["Visit cancelled", move()]), visitId: onVisit };
    case "visit_no_show":
      return { text: join(["Marked a no-show", move()]), visitId: onVisit };
    case "visit_type_change": {
      // Corrected before sign-off. Both bands must be in the closed set to
      // print; anything else in the payload never does.
      const from = band(p.fromBasis);
      const to = band(p.toBasis);
      return {
        text: join([
          from && to && `Visit type: ${words(from)} → ${words(to)}`,
          p.codesCleared === true && "codes cleared",
        ]),
        visitId: onVisit,
      };
    }
    case "visit_series_create": {
      // 0126: counts and a closed form.
      const visits = num(p.visits);
      const every = num(p.every);
      const unit = p.unit === "month" ? "month" : p.unit === "week" ? "week" : null;
      return {
        text: join([
          "Repeating visits booked",
          visits !== null && plural(visits, "visit"),
          every !== null && unit && (every === 1 ? `every ${unit}` : `every ${every} ${unit}s`),
        ]),
        visitId: null,
      };
    }
    case "visit_reschedule": {
      const fields = knownFields(p.fields, RESCHEDULE_FIELDS);
      return {
        text: join(["Rescheduled", fields.length > 0 && `Fields: ${fields.map(words).join(", ")}`]),
        visitId: onVisit,
      };
    }
    case "visit_vitals_record": {
      const fields = list(p.fields);
      return { text: fields.length > 0 ? `Fields: ${fields.map(words).join(", ")}` : "", visitId: onVisit };
    }
    case "visit_note_carry_forward": {
      const copied = Array.isArray(p.copied) ? p.copied.length : (num(p.copied) ?? 0);
      const from = uuid(p.fromVisitId);
      return {
        text: join([`Copied ${plural(copied, "section")}`, from && `from visit ${from.slice(0, 8)}`]),
        visitId: onVisit,
      };
    }
    case "visit_addendum": {
      const length = num(p.length);
      return { text: join(["Addendum signed", length !== null && plural(length, "character")]), visitId: onVisit };
    }
    case "note_template_edit": {
      const version = num(p.version);
      return { text: version !== null ? `Version ${version}` : "", visitId: null };
    }
    case "clinician_profile_update": {
      const fields = list(p.fields);
      const bills = num(p.openBillsUpdated);
      return {
        text: join([
          fields.length > 0 && `Fields: ${fields.map(words).join(", ")}`,
          bills !== null && bills > 0 && `${plural(bills, "open bill")} updated`,
        ]),
        visitId: null,
      };
    }
    case "team_permissions_update": {
      const added = list(p.added);
      const removed = list(p.removed);
      return {
        text: join([added.length > 0 && `Added ${added.join(", ")}`, removed.length > 0 && `removed ${removed.join(", ")}`]),
        visitId: null,
      };
    }
    case "patient_update": {
      const sections = list(p.sections);
      return { text: sections.length > 0 ? `Sections: ${sections.map(words).join(", ")}` : "", visitId: null };
    }
    case "patient_export": {
      const format = str(p.format);
      const bytes = num(p.bytes);
      return {
        text: join([format && format.toUpperCase(), bytes !== null && `${Math.max(1, Math.round(bytes / 1024))} KB`]),
        visitId: null,
      };
    }
    case "payer_roster_change": {
      // Global reference data, not PHI (audit R17), so the payer's own name and
      // states print. Field names only for an edit; never notes or the URL.
      const name = str(p.name);
      const states = list(p.statesServed);
      const fields = list(p.fields).filter((f) => f !== "active");
      return {
        text: join([
          p.op === "create" ? "Payer added" : "Payer edited",
          name,
          states.length > 0 && `States: ${states.join(", ")}`,
          p.op !== "create" && fields.length > 0 && `Fields: ${fields.map(words).join(", ")}`,
          p.active === false && "withdrawn from pickers",
          p.active === true && "reactivated",
        ]),
        visitId: null,
      };
    }
    case "patient_contact_change": {
      // A family member or caregiver on a chart (audit R30): which columns,
      // never the person.
      const fields = knownFields(p.fields, CONTACT_FIELDS);
      const verb = p.op === "create" ? "Contact added" : p.op === "delete" ? "Contact removed" : "Contact edited";
      return { text: join([verb, fields.length > 0 && `Fields: ${fields.map(words).join(", ")}`]), visitId: null };
    }
    case "patient_provider_change": {
      // An outside provider linked to or removed from a chart (audit R30).
      const role = str(p.role);
      return {
        text: join([
          p.op === "unlink" ? "Outside provider removed" : "Outside provider linked",
          role && PROVIDER_ROLES[role],
          p.providerCreated === true && "new to the roster",
        ]),
        visitId: null,
      };
    }
    case "external_provider_change": {
      // The org's roster of outside providers (audit R30).
      const fields = knownFields(p.fields, PROVIDER_FIELDS);
      return {
        text: join([
          p.op === "create" ? "Roster provider added" : "Roster provider edited",
          fields.length > 0 && `Fields: ${fields.map(words).join(", ")}`,
        ]),
        visitId: null,
      };
    }
    case "settings_update": {
      // Every settings row read "—": the payload said what changed and the
      // page never printed it, so "who switched this visit type off" had to be
      // read out of the raw row.
      const what = targetType ? SETTINGS_TARGETS[targetType] : undefined;
      const change = str(p.change);
      const verb = change ? SETTINGS_CHANGES[change] : undefined;
      // On a (de)activation "active" is the change itself, already said.
      const fields = list(p.fields)
        .filter((f) => f !== "active")
        .map((f) => SETTINGS_FIELDS[f])
        .filter((f): f is string => Boolean(f));
      const basis = change === "create" && targetType === "visit_type" ? band(p.codingBasis) : null;
      // A fee's code is a CPT/HCPCS code: five characters, never free text.
      const feeCode = targetType === "fee_schedule" && typeof p.code === "string" && /^[A-Z0-9]{5}$/.test(p.code) ? p.code : null;
      return {
        text: join([
          what && verb ? `${what} ${verb}` : what,
          feeCode && `for ${feeCode}`,
          basis && `bills like ${words(basis)}`,
          fields.length > 0 && `Fields: ${[...new Set(fields)].join(", ")}`,
        ]),
        visitId: null,
      };
    }
    case "referral_create":
      return { text: "Referral received", visitId: null };
    case "referral_update": {
      const fields = list(p.fields).map((f) => REFERRAL_FIELDS[f]).filter((f): f is string => Boolean(f));
      return { text: join(["Referral edited", fields.length > 0 && `Fields: ${fields.join(", ")}`]), visitId: null };
    }
    case "referral_stage": {
      const from = str(p.from) && REFERRAL_STAGES[p.from as string];
      const to = str(p.to) && REFERRAL_STAGES[p.to as string];
      const code = reasonCode(p.reasonCode);
      return {
        text: join([from && to ? `${from} → ${to}` : to, code && `code ${code}`]),
        visitId: null,
      };
    }
    case "referral_requirements": {
      const done = num(p.done);
      const total = num(p.total);
      return {
        text: done !== null && total !== null ? `Requirements: ${done} of ${total} done` : "Requirements updated",
        visitId: null,
      };
    }
    case "referral_triage":
      return { text: "Triage recorded", visitId: null };
    case "insurance_verification": {
      const method = str(p.method) && VERIFY_METHODS[p.method as string];
      const result = str(p.result) && VERIFY_RESULTS[p.result as string];
      return {
        text: join([
          "Coverage checked",
          method,
          result,
          p.subject === "referral" ? "for a referral" : p.subject === "patient" ? "for a patient" : null,
        ]),
        visitId: null,
      };
    }
    case "reason_code_change": {
      const code = reasonCode(p.code);
      const kind = p.kind === "ntuc" ? "NTUC code" : p.kind === "discharge" ? "Discharge code" : "Reason code";
      const fields = list(p.fields).map((f) => REASON_CODE_FIELDS[f]).filter((f): f is string => Boolean(f));
      return {
        text: join([
          `${kind}${code ? ` ${code}` : ""} ${p.op === "create" ? "added" : "edited"}`,
          p.op !== "create" && fields.length > 0 && `Fields: ${fields.join(", ")}`,
        ]),
        visitId: null,
      };
    }
    case "document_upload": {
      const kind = str(p.kind) && DOCUMENT_KINDS[p.kind as string];
      const type = str(p.contentType) && DOCUMENT_TYPES[p.contentType as string];
      const kb = num(p.sizeBytes);
      return {
        text: join([
          "Document added",
          kind,
          type && kb !== null ? `${type}, ${Math.max(1, Math.round(kb / 1024))} KB` : type,
          p.subject === "referral" ? "to a referral" : p.subject === "patient" ? "to a chart" : null,
        ]),
        visitId: null,
      };
    }
    case "document_view":
      return { text: "Document opened", visitId: null };
    case "document_remove": {
      const kind = str(p.kind) && DOCUMENT_KINDS[p.kind as string];
      return { text: join(["Document removed as filed in error", kind]), visitId: null };
    }
    case "acuity_change": {
      const level = str(p.acuity) && ACUITIES[p.acuity as string];
      return { text: join(["Acuity given at the visit", level]), visitId: onVisit };
    }
    case "hospice_assessment":
      return {
        text: p.eligible === true ? "Hospice eligibility assessed: eligible" : p.eligible === false ? "Hospice eligibility assessed: not eligible" : "Hospice eligibility assessed",
        visitId: null,
      };
    case "patient_event_change": {
      const kind = str(p.kind) && EVENT_KINDS[p.kind as string];
      const op = str(p.op) && EVENT_OPS[p.op as string];
      return { text: kind && op ? `${kind[0]!.toUpperCase()}${kind.slice(1)} ${op}` : "Event changed", visitId: null };
    }
    case "patient_discharge": {
      const code = reasonCode(p.reasonCode);
      if (p.op === "readmit") return { text: "Readmitted to care", visitId: null };
      if (p.op === "hospice_details") return { text: "Hospice stay details recorded", visitId: null };
      if (p.op === "hospice_outcome") {
        const end = str(p.endReason) && HOSPICE_ENDS[p.endReason as string];
        return { text: join(["Hospice stay ended", end]), visitId: null };
      }
      return {
        text: join([p.status === "deceased" ? "Discharged: died on service" : "Discharged", code && `code ${code}`]),
        visitId: null,
      };
    }
    case "clinical_list_change": {
      if (p.list === "no_known_allergies") return { text: "No known allergies recorded", visitId: null };
      const listName = str(p.list) && CLINICAL_LISTS[p.list as string];
      const op = str(p.op) && CLINICAL_OPS[p.op as string];
      const fields = list(p.fields).map((f) => CLINICAL_FIELDS[f]).filter((f): f is string => Boolean(f));
      return {
        text: join([
          listName && op ? `Entry ${op} the ${listName.toLowerCase()}` : listName || "Clinical list changed",
          p.op === "edit" && fields.length > 0 && `Fields: ${fields.join(", ")}`,
        ]),
        visitId: null,
      };
    }
    case "care_plan_update": {
      const parts = list(p.parts).map((x) => CARE_PLAN_PARTS[x]).filter((x): x is string => Boolean(x));
      return {
        text: join([
          num(p.version) !== null ? `Care plan saved (v${num(p.version)})` : "Care plan saved",
          p.duringVisit === true && "during a visit",
          parts.length > 0 && `Parts: ${parts.join(", ")}`,
        ]),
        visitId: null,
      };
    }
    case "care_program_enrollment": {
      const program = str(p.program) && PROGRAMS[p.program as string];
      const consent =
        p.op === "enroll" && (p.consentMethod === "verbal" || p.consentMethod === "written") ? `${p.consentMethod} consent` : null;
      return { text: join([p.op === "end" ? "Enrolment ended" : "Enrolled", program, consent]), visitId: null };
    }
    case "phone_encounter":
      return {
        text: p.op === "void" ? "Phone call voided as recorded in error" : p.direction === "inbound" ? "Phone call recorded: they called" : "Phone call recorded",
        visitId: null,
      };
    case "escalation_alert": {
      const m = str(p.measure) && ESCALATION_MEASURES_TEXT[p.measure as string];
      const op = str(p.op) && ALERT_OPS[p.op as string];
      return { text: op ? join([op, m]) : "Escalation alert", visitId: null };
    }
    case "care_task": {
      const d = str(p.discipline) && DISCIPLINES_TEXT[p.discipline as string];
      const op = str(p.op) && TASK_OPS[p.op as string];
      const fields = list(p.fields).map((f) => TASK_FIELDS[f]).filter((f): f is string => Boolean(f));
      return {
        text: join([
          op ? `Task ${op}` : "Task changed",
          d && `for ${d}`,
          p.op === "edit" && fields.length > 0 && `Fields: ${fields.join(", ")}`,
        ]),
        visitId: null,
      };
    }
    case "care_management_time": {
      const program = (str(p.program) && PROGRAMS[p.program as string]) || "PCM/CCM";
      if (p.op === "void") return { text: join([`${program} time voided as recorded in error`, p.fromCall === true && "with its call"]), visitId: null };
      const minutes = num(p.minutes);
      const kind = str(p.kind) && CM_KINDS[p.kind as string];
      const activity = str(p.activity) && CM_ACTIVITIES_TEXT[p.activity as string];
      return {
        text: join([
          `${program} time logged`,
          minutes !== null && plural(minutes, "minute"),
          kind,
          p.fromCall === true ? "from a call" : activity,
        ]),
        visitId: null,
      };
    }
    case "claim_export": {
      const claims = num(p.claims);
      const lines = num(p.lines);
      return {
        text: join([
          "Claims exported for billing",
          claims !== null && plural(claims, "claim"),
          lines !== null && plural(lines, "line"),
        ]),
        visitId: null,
      };
    }
    case "clearinghouse_connection": {
      const vendor = (str(p.vendor) && CLEARINGHOUSES[p.vendor as string]) || "Clearinghouse";
      const op = (str(p.op) && CONNECTION_OPS[p.op as string]) || "connection changed";
      const fields = list(p.fields).filter((f) => /^[A-Za-z0-9_.]+$/.test(f));
      const secrets = list(p.secrets).filter((s) => /^[A-Za-z]+$/.test(s));
      return {
        text: join([
          `${vendor} ${op}`,
          p.op === "test" && (p.ok === true ? "passed" : "failed"),
          fields.length > 0 && `fields: ${fields.join(", ")}`,
          secrets.length > 0 && `secrets: ${secrets.join(", ")}`,
          p.hostKeyPinned === true && "host key recorded",
          p.hostKeyReset === true && "host key reset",
        ]),
        visitId: null,
      };
    }
    case "claim_submission": {
      const vendor = (str(p.vendor) && CLEARINGHOUSES[p.vendor as string]) || "the clearinghouse";
      const claims = num(p.claims);
      const how = p.op === "download" ? `837P file downloaded for ${vendor}` : p.op === "send_failed" ? `837P file not sent to ${vendor}` : `837P file sent to ${vendor}`;
      return { text: join([how, claims !== null && plural(claims, "claim")]), visitId: null };
    }
    case "clearinghouse_file": {
      const kind = (str(p.kind) && FILE_KINDS[p.kind as string]) || "Response file";
      const applied = num(p.claimsUpdated);
      return {
        text: join([`${kind} read`, p.source === "upload" ? "uploaded" : p.source === "sftp" ? "from the clearinghouse" : null, applied !== null && `${plural(applied, "claim")} updated`]),
        visitId: null,
      };
    }
    case "claim_status_check": {
      const state = str(p.state);
      return { text: join(["Claim status asked of the payer", state && `answer: ${words(state)}`]), visitId: uuid(p.visitId) };
    }
    case "logout":
      // 0121: the reason is a closed set.
      return { text: p.reason === "idle" ? "Signed out after the idle limit" : "Signed out", visitId: null };
    case "mfa_change":
      return {
        text:
          p.change === "disabled"
            ? "Second factor turned off"
            : join([
                "Second factor set up",
                p.via === "login" ? "at sign-in" : p.via === "settings" ? "on Settings → Security" : null,
              ]),
        visitId: null,
      };
    case "prior_auth_change":
      // 0124: a closed set; the id stays in the payload, the number never was.
      return {
        text:
          p.change === "add"
            ? "Prior authorization added"
            : p.change === "withdraw"
              ? "Prior authorization withdrawn as recorded in error"
              : "Prior authorization corrected",
        visitId: null,
      };
    case "kpi_history_change": {
      // 0125: counts and the months' closed form; a figure never goes in.
      const set = num(p.entered);
      const cleared = num(p.cleared);
      const from = str(p.from) && /^\d{4}-\d{2}$/.test(p.from as string) ? (p.from as string) : null;
      const to = str(p.to) && /^\d{4}-\d{2}$/.test(p.to as string) ? (p.to as string) : null;
      return {
        text: join([
          "Monthly figures changed",
          set ? `${plural(set, "figure")} entered` : null,
          cleared ? `${plural(cleared, "figure")} cleared` : null,
          from && to && (from === to ? from : `${from} to ${to}`),
        ]),
        visitId: null,
      };
    }
    case "ncci_load": {
      // 0122: the kind and the dates are closed forms; the rest are counts.
      const what = p.kind === "mue" ? "MUE values" : "NCCI pairs";
      const kept = num(p.rowsKept);
      const from = str(p.inForceFrom) && /^\d{4}-\d{2}-\d{2}$/.test(p.inForceFrom as string) ? (p.inForceFrom as string) : null;
      return {
        text: join([
          p.change === "removed" ? `${what} no longer used` : `${what} loaded from CMS's files`,
          kept !== null && plural(kept, p.kind === "mue" ? "code" : "pair"),
          from && `in force from ${from}`,
        ]),
        visitId: null,
      };
    }
    case "care_management_charge": {
      const program = (str(p.program) && PROGRAMS[p.program as string]) || "PCM/CCM";
      const codes = list(p.cptCodes).filter((c) => CPT_RE.test(c));
      const units = num(p.addOnUnits);
      const basis = str(p.basis) && CM_BASES[p.basis as string];
      return {
        text: join([
          `${program} month charged`,
          codes.length > 0 && `CPT ${codes.join(", ")}`,
          units !== null && units > 1 && `${units} add-on units`,
          basis && `on ${basis}`,
        ]),
        visitId: uuid(p.visitId),
      };
    }
    default:
      return { text: "", visitId: onVisit };
  }
}

/**
 * Keys that hold free text, removed from payloads before they leave the
 * server. The writer rule is ids, field names and counts only, but one older
 * writer (superbill_code_override) stored the biller's typed reason, and an
 * audit row cannot be edited for six years. So /api/audit strips these
 * whatever the row says.
 */
const FREE_TEXT_KEYS = new Set(["reason", "notes", "note", "body", "text", "comment", "message"]);

export function redactAuditPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload ?? {})) if (!FREE_TEXT_KEYS.has(k)) out[k] = v;
  return out;
}
