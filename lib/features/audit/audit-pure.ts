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
          paid !== null && `paid ${money(paid)}`,
          overBilled !== null && `more than the ${money(overBilled)} billed, confirmed as an overpayment`,
          over.length > 0 && `submitted over a documentation gap (${over.map(words).join(", ")})`,
          gap.length > 0 && `documentation gap (${gap.map(words).join(", ")})`,
          // Posted from a payer's 835 rather than typed (audit R10).
          p.source === "remittance" && "per payer remittance",
        ]),
        visitId: uuid(p.visitId),
      };
    }
    case "denial_decision": {
      const d = str(p.decision);
      return { text: d ? `Decision: ${words(d)}` : "", visitId: uuid(p.visitId) };
    }
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
