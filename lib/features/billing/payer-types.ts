/**
 * payer.payer_type values, as data (audit R17).
 *
 * Mirrors the CHECK in db/migrations/0003_payers_and_rules.sql. This was a
 * type union in payer-rule.repository.ts, which nothing could iterate: the
 * payer roster form needs the list itself, and the create API validates
 * against it, so a type the CHECK would refuse comes back as a 422 sentence
 * instead of a constraint violation. Kept free of any DB import so the client
 * roster page can use it; the repository re-exports it.
 */
export const PAYER_TYPES = [
  "medicare_mac",
  "medicare_advantage_org",
  "medicaid_state",
  "medicaid_mco",
  "commercial",
  "tpa",
  "workers_comp",
  "auto_no_fault",
  "tribal",
  "self_insured",
  "other",
] as const;

export type PayerType = (typeof PAYER_TYPES)[number];

/** What the roster screen calls each type. */
export const PAYER_TYPE_LABELS: Record<PayerType, string> = {
  medicare_mac: "Medicare (MAC)",
  medicare_advantage_org: "Medicare Advantage",
  medicaid_state: "Medicaid (state)",
  medicaid_mco: "Medicaid MCO",
  commercial: "Commercial",
  tpa: "TPA",
  workers_comp: "Workers' comp",
  auto_no_fault: "Auto / no-fault",
  tribal: "Tribal",
  self_insured: "Self-insured",
  other: "Other",
};
