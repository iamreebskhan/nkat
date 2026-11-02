/**
 * Discharge and NTUC (not taken under care) reason codes.
 *
 * The numbering of the practice's current EHR, as its monthly Trend Report
 * counts them ('Discharges and NTUC' sheet): discharges 01-10 with 01b/02b,
 * NTUC 20a-27 (Level-1 doc:108-109). Mark Q11a default: preloaded and
 * editable. The labels are generic: in the practice's own list, the partner
 * hospice and the hospitals a referral came from are named, and those names
 * are each practice's to fill in. Each practice renames, adds or retires codes
 * on Settings → Reason codes; the number is what the reports match on, so it
 * stays.
 *
 * `category` is what a report counts a code as: a transition to the partner
 * hospice or to another one, a death on service, and so on. Pure, so the
 * service, the settings page and the specs read one list.
 */

export const REASON_CODE_KINDS = ["discharge", "ntuc"] as const;
export type ReasonCodeKind = (typeof REASON_CODE_KINDS)[number];

export const REASON_CATEGORIES = [
  "hospice_partner",
  "hospice_other",
  "goals_met",
  "moved",
  "lost_contact",
  "declined",
  "death",
  "non_compliance",
  "other_agency",
  "not_appropriate",
  "other",
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export const REASON_CATEGORY_LABEL: Record<ReasonCategory, string> = {
  hospice_partner: "To the partner hospice",
  hospice_other: "To another hospice",
  goals_met: "Goals met",
  moved: "Moved out of the area",
  lost_contact: "Could not be contacted",
  declined: "Declined",
  death: "Died",
  non_compliance: "Non-compliance",
  other_agency: "Chose another agency",
  not_appropriate: "Not appropriate for palliative care",
  other: "Other",
};

export interface ReasonCodeDefault {
  kind: ReasonCodeKind;
  code: string;
  label: string;
  category: ReasonCategory;
  sortOrder: number;
}

/** The numbering of a code: two digits, then an optional letter. */
export const REASON_CODE_PATTERN = /^[0-9]{2}[a-z]?$/;

export const DEFAULT_REASON_CODES: readonly ReasonCodeDefault[] = [
  { kind: "discharge", code: "01", label: "Hospice - partner hospice", category: "hospice_partner", sortOrder: 10 },
  { kind: "discharge", code: "01b", label: "Hospice - partner hospice, from hospital", category: "hospice_partner", sortOrder: 11 },
  { kind: "discharge", code: "02", label: "Hospice - other", category: "hospice_other", sortOrder: 20 },
  { kind: "discharge", code: "02b", label: "Hospice - other, from hospital", category: "hospice_other", sortOrder: 21 },
  { kind: "discharge", code: "03", label: "Goals met", category: "goals_met", sortOrder: 30 },
  { kind: "discharge", code: "04", label: "To another hospice", category: "hospice_other", sortOrder: 40 },
  { kind: "discharge", code: "05", label: "Moved out of area", category: "moved", sortOrder: 50 },
  { kind: "discharge", code: "06", label: "Cannot contact", category: "lost_contact", sortOrder: 60 },
  { kind: "discharge", code: "07", label: "Declined service", category: "declined", sortOrder: 70 },
  { kind: "discharge", code: "08", label: "Death on palliative care", category: "death", sortOrder: 80 },
  { kind: "discharge", code: "09", label: "Non-compliance", category: "non_compliance", sortOrder: 90 },
  { kind: "discharge", code: "10", label: "Other / unknown", category: "other", sortOrder: 100 },
  { kind: "ntuc", code: "20a", label: "Declined service", category: "declined", sortOrder: 200 },
  { kind: "ntuc", code: "20b", label: "Declined service - financial / insurance", category: "declined", sortOrder: 201 },
  { kind: "ntuc", code: "21a", label: "To the partner hospice", category: "hospice_partner", sortOrder: 210 },
  { kind: "ntuc", code: "21b", label: "To the partner hospice, from hospital", category: "hospice_partner", sortOrder: 211 },
  { kind: "ntuc", code: "22a", label: "To another hospice", category: "hospice_other", sortOrder: 220 },
  { kind: "ntuc", code: "22b", label: "To another hospice, from hospital", category: "hospice_other", sortOrder: 221 },
  { kind: "ntuc", code: "23", label: "Chose another palliative care or home health agency", category: "other_agency", sortOrder: 230 },
  { kind: "ntuc", code: "24", label: "Unable to contact", category: "lost_contact", sortOrder: 240 },
  { kind: "ntuc", code: "25", label: "Not palliative care appropriate", category: "not_appropriate", sortOrder: 250 },
  { kind: "ntuc", code: "26", label: "Death before admission", category: "death", sortOrder: 260 },
  { kind: "ntuc", code: "27", label: "Other", category: "other", sortOrder: 270 },
];

/** "21a To the partner hospice" — how a code reads in a list or a report. */
export function reasonCodeText(c: { code: string; label: string }): string {
  return `${c.code} ${c.label}`;
}
