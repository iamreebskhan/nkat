/**
 * The default palliative visit-note template.
 *
 * Derived from the note Mark Hendrix wrote and calls "the perfect note", which
 * he sent after the 20 Aug 2026 walkthrough. Two things about that document
 * shape what is and is not here.
 *
 * FIRST, he told us to drop part of it. His message with the PDF: "Please
 * ignore the last sections about time capture and next visit, as those sections
 * are outdated." That is the final paragraph of page 4 — the time attestation
 * ("Time spent this visit was 60 minutes… Greater than 50% of time spent in
 * counseling") and the follow-up sentence. He is right, and not only because he
 * says so: the ">50% of time in counselling" basis stopped being a valid way to
 * select an office/outpatient E/M code with the 2021 revision. Pallio captures
 * time structurally in the Time card and scheduling owns the next visit, so
 * reproducing either as prose would be duplicating structured data in a form
 * nobody can query — and in the counselling case, duplicating it in a form that
 * is no longer correct.
 *
 * SECOND, he attached his own caveat, twice and unprompted: "I developed it
 * over eight years ago… it's not quite current to current technology and
 * current rules." So this is a starting point an org edits, not an authority.
 * It ships as version 1 of an org's template and every field is theirs to
 * change.
 *
 * The care-team header of his note (Palliative Care Provider, Primary Care
 * Provider, Referring Physician, Pulmonologist, Oncologist) is deliberately NOT
 * a prose section. Those are relationships, and the patient record already
 * models a care team; typing them into free text would create a second,
 * unqueryable copy that immediately drifts. The header renders from
 * patient_external_provider and patient_contact instead, through
 * careTeamHeaderRows in note-render.ts (audit R30).
 */

export type NoteSectionKind = "prose" | "vitals" | "list";

export interface NoteSectionDef {
  sectionKey: string;
  label: string;
  helpText?: string;
  kind: NoteSectionKind;
  isRequired: boolean;
  /**
   * Visit-type slugs this section is NOT required on, even when isRequired.
   * Empty/absent means required on every visit type.
   */
  notRequiredForVisitTypes?: string[];
}

/**
 * Visit types with no hands-on examination and no measurable vitals.
 *
 * Not a judgement about how thorough the clinician was — there is simply no
 * way to weigh a patient over video or during a telephone advance-care-planning
 * conversation.
 *
 * "telehealth" here also means the MODALITY (audit R22): it exempts any visit
 * with the telehealth box ticked, whatever its type — see sectionIsRequiredFor.
 */
const NO_PHYSICAL_CONTACT = ["advance_care_planning", "telehealth"];

/**
 * A bereavement follow-up is a visit to the FAMILY after the patient has died.
 * There is no one to examine, no vitals to take, and no history of the
 * patient's present illness to write — the illness is over. Requiring any of
 * those would make the encounter unsignable.
 */
const BEREAVEMENT = "bereavement_follow_up";

/**
 * The required set is the four Mark named, plus Assessment and Plan.
 *
 * [05:55] "each note that you have to have has an HPI, which is history of
 * present illness, social history — and just kind of these typed-in texts. And
 * then the rest is like a physical exam." [06:29] "so you're going to collect
 * their vitals". That is HPI, social history, physical exam, vitals, and it is
 * the answer to "what must a note have" — so those four block signing.
 *
 * Assessment and Plan is ours, not his. He did not name it, but it is what the
 * billed code is defended with: the audit packet reconciles the codes on the
 * superbill against what the note says was decided, and with no A&P there is
 * nothing to reconcile against.
 *
 * Requiredness is per visit type, because his four describe a HOME visit. A
 * blanket rule would refuse encounters that are legitimate and routine —
 * see NO_PHYSICAL_CONTACT and BEREAVEMENT above. Every exception is a visit
 * type where the section cannot be produced at all, never one where it would
 * merely be inconvenient.
 *
 * Payer-specific documentation requirements are enforced separately, against
 * documentation_requirement.required_chart_elements, which is where a rule like
 * "this payer requires vitals for this code" belongs.
 */
export const DEFAULT_NOTE_SECTIONS: NoteSectionDef[] = [
  {
    sectionKey: "reason_for_visit",
    label: "Reason for visit",
    helpText: "Why this encounter happened — referral, follow-up, crisis.",
    kind: "prose",
    isRequired: false,
  },
  {
    sectionKey: "chief_complaint",
    label: "Chief complaint",
    helpText: "In the patient's own words where possible.",
    kind: "prose",
    isRequired: false,
  },
  {
    sectionKey: "hpi",
    label: "History of present illness",
    helpText: "The narrative of the current illness and what has changed since the last visit.",
    kind: "prose",
    isRequired: true,
    notRequiredForVisitTypes: [BEREAVEMENT],
  },
  {
    sectionKey: "past_medical_history",
    label: "Past medical history",
    kind: "list",
    isRequired: false,
  },
  {
    sectionKey: "past_surgical_history",
    label: "Past surgical history",
    kind: "list",
    isRequired: false,
  },
  {
    sectionKey: "social_history",
    label: "Social history",
    helpText: "Living situation, caregivers, substance use, advance-directive status.",
    kind: "prose",
    isRequired: true,
    notRequiredForVisitTypes: [BEREAVEMENT],
  },
  {
    sectionKey: "family_history",
    label: "Family history",
    kind: "prose",
    isRequired: false,
  },
  {
    sectionKey: "code_status",
    label: "Code status",
    helpText: "Full code, DNR/DNI, POLST/MOLST on file.",
    kind: "prose",
    isRequired: false,
  },
  {
    sectionKey: "vitals",
    label: "Vitals",
    helpText: "Weight is tracked across visits — the trend is what matters in palliative care.",
    kind: "vitals",
    isRequired: true,
    notRequiredForVisitTypes: [...NO_PHYSICAL_CONTACT, BEREAVEMENT],
  },
  {
    sectionKey: "allergies",
    label: "Allergies",
    kind: "list",
    isRequired: false,
  },
  {
    sectionKey: "medications",
    label: "Medications",
    helpText: "One per line, with dose, route, frequency and any change made today.",
    kind: "list",
    isRequired: false,
  },
  {
    sectionKey: "review_of_systems",
    label: "Review of systems",
    kind: "prose",
    isRequired: false,
  },
  {
    sectionKey: "physical_exam",
    label: "Physical examination",
    kind: "prose",
    isRequired: true,
    notRequiredForVisitTypes: [...NO_PHYSICAL_CONTACT, BEREAVEMENT],
  },
  {
    sectionKey: "goals_of_care",
    label: "Goals of care",
    helpText: "The palliative core of the note — what the patient wants, and what changed.",
    kind: "prose",
    isRequired: false,
  },
  {
    sectionKey: "assessment_and_plan",
    label: "Assessment and plan",
    helpText: "Numbered by problem. This is what the billed codes are defended with.",
    kind: "prose",
    isRequired: true,
  },
];

export const DEFAULT_TEMPLATE_NAME = "Palliative visit note";

/** Section keys the default template declares, for validation and tests. */
export const DEFAULT_SECTION_KEYS: string[] = DEFAULT_NOTE_SECTIONS.map(
  (s) => s.sectionKey,
);

/**
 * Is this section required on THIS visit?
 *
 * One definition, used by the note read, the sign guard and the tests, so the
 * "required" chip a clinician sees can never disagree with what actually
 * blocks the signature.
 *
 * `isTelehealth` is the visit's own modality flag (audit R22). A "telehealth"
 * entry in the exception list exempts every telehealth visit, not only visits
 * on the type whose slug is "telehealth": nobody can examine a new patient
 * over video either. transitionVisit's missing_required query mirrors this.
 */
export function sectionIsRequiredFor(
  section: { isRequired: boolean; notRequiredForVisitTypes?: string[] | null },
  visitType: string | null | undefined,
  isTelehealth = false,
): boolean {
  if (!section.isRequired) return false;
  const exempt = section.notRequiredForVisitTypes ?? [];
  if (isTelehealth && exempt.includes("telehealth")) return false;
  if (!visitType) return true;
  return !exempt.includes(visitType);
}

/**
 * Is a section's stored content empty?
 *
 * Mirrors noteIsEmpty in visit-pure.ts but over the per-section JSONB shapes:
 * prose holds a TipTap document, list holds {items: string[]}, and vitals holds
 * nothing here at all — its content lives in visit_vitals, so a vitals section
 * is judged by whether that row has any reading on it, never by this.
 */
export function sectionContentIsEmpty(
  kind: NoteSectionKind,
  content: unknown,
): boolean {
  if (content == null) return true;
  if (kind === "list") {
    const items = (content as { items?: unknown }).items;
    return (
      !Array.isArray(items) ||
      items.every((i) => typeof i !== "string" || i.trim() === "")
    );
  }
  if (kind === "vitals") {
    // Never stored here — the caller checks visit_vitals instead.
    return true;
  }
  return !proseHasText(content);
}

function proseHasText(node: unknown): boolean {
  if (node == null) return false;
  if (Array.isArray(node)) return node.some(proseHasText);
  if (typeof node !== "object") return false;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof n.text === "string" && n.text.trim() !== "") return true;
  if (
    typeof n.type === "string" &&
    !["doc", "paragraph", "text", "hardBreak", "hard_break"].includes(n.type) &&
    !Array.isArray(n.content)
  ) {
    return true;
  }
  return Array.isArray(n.content) && n.content.some(proseHasText);
}
