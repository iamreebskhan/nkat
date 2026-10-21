/**
 * Where a visit took place, as a CMS place-of-service code (audit R23).
 *
 * Every claim used to be billed as POS 12 (home), or 10 when the telehealth
 * box was ticked, by inference. Nothing recorded where the visit happened, so
 * an assisted-living, nursing-facility or hospice visit went out as a home
 * visit. Pure, so the document page, the bill, the audit packet and the tests
 * all share one list and one wording.
 */
export const VISIT_POS_OPTIONS = [
  { code: "12", label: "Home" },
  { code: "13", label: "Assisted living facility" },
  { code: "14", label: "Group home" },
  { code: "33", label: "Custodial care facility" },
  { code: "32", label: "Nursing facility" },
  { code: "31", label: "Skilled nursing facility" },
  { code: "34", label: "Hospice" },
  { code: "21", label: "Inpatient hospital" },
  { code: "11", label: "Office" },
  { code: "10", label: "Telehealth, patient at home" },
  { code: "02", label: "Telehealth, patient not at home" },
  { code: "99", label: "Other" },
] as const;

const TELEHEALTH_POS = new Set(["02", "10"]);

/** The prefill when nothing is recorded: 10 for telehealth, otherwise 12 (home). */
export function defaultPosFor(isTelehealth: boolean): string {
  return isTelehealth ? "10" : "12";
}

/** "13 · Assisted living facility"; the bare code when it is not a listed option. */
export function posLabel(code: string | null | undefined): string {
  if (!code) return "not recorded";
  const o = VISIT_POS_OPTIONS.find((x) => x.code === code);
  return o ? `${o.code} · ${o.label}` : code;
}

/** A message when an in-person visit carries a telehealth place of service. */
export function posTelehealthConflict(
  pos: string | null | undefined,
  isTelehealth: boolean,
): string | null {
  if (!pos || isTelehealth || !TELEHEALTH_POS.has(pos)) return null;
  return `Place of service ${posLabel(pos)} is a telehealth code, but the visit is recorded as in person.`;
}
