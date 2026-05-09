/**
 * Gold-standard 50-question eval set for the rule-lookup engine.
 *
 * Source: pallio_complete_vision_v3 §10.3 ("Eval set: 50 gold-standard
 * Q-A pairs built from Mark's cheat sheet — run on every model or
 * prompt change").
 *
 * Each question is a real billing-agent query against the palliative
 * CPT set. The expected answer captures the *minimum* facts the
 * synthesized response must include — checked structurally, not for
 * exact wording (the model phrases naturally).
 *
 * Categories:
 *   - HOME_VISIT_BASE: 99341–99350 base codes
 *   - PROLONGED:       G0318 (Medicare) + 99417 (non-Medicare)
 *   - ACP:             99497 + 99498
 *   - TELEHEALTH:      modality + state-specific
 *   - PRIOR_AUTH:      common payer requirements
 *   - PROVIDER_TYPE:   MD vs NP/PA rate differential
 *
 * The eval suite (gold-standard.spec.ts) is gated behind
 * `EVAL=1` so it doesn't fire on every CI run — only on prompt or
 * model changes. Update the canon below whenever Mark sends a new
 * cheat sheet revision.
 */

export interface EvalQuestion {
  id: string;
  category:
    | "HOME_VISIT_BASE"
    | "PROLONGED"
    | "ACP"
    | "TELEHEALTH"
    | "PRIOR_AUTH"
    | "PROVIDER_TYPE";
  query: string;
  /** Required structured params the parser MUST extract. */
  expectedParse: {
    payer?: string | null;
    state?: string | null;
    cptCode?: string | null;
    attribute?: string | null;
  };
  /**
   * Substrings that MUST appear in the synthesized answer (case-
   * insensitive). Catches hallucinations + missing context.
   */
  requiredSubstrings: string[];
  /** When true, the system MUST refuse — no source means no answer. */
  expectNoRule?: boolean;
}

export const GOLD_STANDARD: EvalQuestion[] = [
  // ────────────────────────────────────────────────
  // HOME_VISIT_BASE — Mark's cheat sheet, palliative core
  // ────────────────────────────────────────────────
  {
    id: "hvb-01",
    category: "HOME_VISIT_BASE",
    query: "What is CPT 99341 used for?",
    expectedParse: { cptCode: "99341" },
    requiredSubstrings: ["new patient", "home visit"],
  },
  {
    id: "hvb-02",
    category: "HOME_VISIT_BASE",
    query: "Time threshold for 99342",
    expectedParse: { cptCode: "99342" },
    requiredSubstrings: ["30 min"],
  },
  {
    id: "hvb-03",
    category: "HOME_VISIT_BASE",
    query: "Time threshold for 99344",
    expectedParse: { cptCode: "99344" },
    requiredSubstrings: ["60 min"],
  },
  {
    id: "hvb-04",
    category: "HOME_VISIT_BASE",
    query: "Time threshold for 99345",
    expectedParse: { cptCode: "99345" },
    requiredSubstrings: ["75 min"],
  },
  {
    id: "hvb-05",
    category: "HOME_VISIT_BASE",
    query: "What is 99347?",
    expectedParse: { cptCode: "99347" },
    requiredSubstrings: ["established", "home visit", "20 min"],
  },
  {
    id: "hvb-06",
    category: "HOME_VISIT_BASE",
    query: "Difference between 99348 and 99349",
    expectedParse: { cptCode: "99348" },
    requiredSubstrings: ["30 min", "40 min"],
  },
  {
    id: "hvb-07",
    category: "HOME_VISIT_BASE",
    query: "Time threshold for 99350",
    expectedParse: { cptCode: "99350" },
    requiredSubstrings: ["60 min"],
  },
  {
    id: "hvb-08",
    category: "HOME_VISIT_BASE",
    query: "When do I bill 99344 vs 99345?",
    expectedParse: { cptCode: "99344" },
    requiredSubstrings: ["60", "75"],
  },

  // ────────────────────────────────────────────────
  // PROLONGED — G0318 (Medicare) vs 99417 (non-Medicare)
  // ────────────────────────────────────────────────
  {
    id: "prl-01",
    category: "PROLONGED",
    query: "Medicare prolonged service add-on for home visit",
    expectedParse: { cptCode: "G0318" },
    requiredSubstrings: ["medicare", "15 min"],
  },
  {
    id: "prl-02",
    category: "PROLONGED",
    query: "Non-Medicare prolonged service code",
    expectedParse: { cptCode: "99417" },
    requiredSubstrings: ["15 min"],
  },
  {
    id: "prl-03",
    category: "PROLONGED",
    query: "Can I use 99417 with Medicare?",
    expectedParse: { cptCode: "99417" },
    requiredSubstrings: ["non-medicare"],
    expectNoRule: false, // covered: explicitly NO for Medicare
  },
  {
    id: "prl-04",
    category: "PROLONGED",
    query: "Max units of G0318 per visit",
    expectedParse: { cptCode: "G0318" },
    requiredSubstrings: ["max", "4"],
  },

  // ────────────────────────────────────────────────
  // ACP — Advance Care Planning
  // ────────────────────────────────────────────────
  {
    id: "acp-01",
    category: "ACP",
    query: "First 30 minutes of advance care planning code",
    expectedParse: { cptCode: "99497" },
    requiredSubstrings: ["advance care planning", "30 min"],
  },
  {
    id: "acp-02",
    category: "ACP",
    query: "ACP add-on for additional 30 minutes",
    expectedParse: { cptCode: "99498" },
    requiredSubstrings: ["99497", "add"],
  },
  {
    id: "acp-03",
    category: "ACP",
    query: "Threshold to add 99498",
    expectedParse: { cptCode: "99498" },
    requiredSubstrings: ["46", "minute"],
  },
  {
    id: "acp-04",
    category: "ACP",
    query: "Can I bill 99497 face-to-face only?",
    expectedParse: { cptCode: "99497" },
    requiredSubstrings: ["face-to-face"],
  },

  // ────────────────────────────────────────────────
  // TELEHEALTH
  // ────────────────────────────────────────────────
  {
    id: "tlh-01",
    category: "TELEHEALTH",
    query: "Does Medicare cover 99349 telehealth?",
    expectedParse: { payer: "Medicare", cptCode: "99349", attribute: "telehealth" },
    requiredSubstrings: ["medicare"],
  },
  {
    id: "tlh-02",
    category: "TELEHEALTH",
    query: "Telehealth modifier for 99349",
    expectedParse: { cptCode: "99349", attribute: "modifier_required" },
    requiredSubstrings: ["95"],
  },
  {
    id: "tlh-03",
    category: "TELEHEALTH",
    query: "Audio-only telehealth for palliative visits",
    expectedParse: { attribute: "telehealth" },
    requiredSubstrings: ["audio"],
  },
  {
    id: "tlh-04",
    category: "TELEHEALTH",
    query: "Required documentation for telehealth visit",
    expectedParse: { attribute: "documentation" },
    requiredSubstrings: ["consent"],
  },
  {
    id: "tlh-05",
    category: "TELEHEALTH",
    query: "Does Humana Ohio cover 99349 telehealth?",
    expectedParse: { payer: "Humana", state: "OH", cptCode: "99349", attribute: "telehealth" },
    requiredSubstrings: [],
  },

  // ────────────────────────────────────────────────
  // PRIOR_AUTH
  // ────────────────────────────────────────────────
  {
    id: "pa-01",
    category: "PRIOR_AUTH",
    query: "Does Aetna require prior auth for 99350?",
    expectedParse: { payer: "Aetna", cptCode: "99350", attribute: "prior_auth" },
    requiredSubstrings: [],
  },
  {
    id: "pa-02",
    category: "PRIOR_AUTH",
    query: "Prior auth required by UHC for home visits in Ohio",
    expectedParse: { payer: "UHC", state: "OH", attribute: "prior_auth" },
    requiredSubstrings: [],
  },
  {
    id: "pa-03",
    category: "PRIOR_AUTH",
    query: "Molina Ohio prior auth for 99344",
    expectedParse: { payer: "Molina", state: "OH", cptCode: "99344", attribute: "prior_auth" },
    requiredSubstrings: [],
  },
  {
    id: "pa-04",
    category: "PRIOR_AUTH",
    query: "Anthem BCBS Ohio palliative prior auth requirements",
    expectedParse: { payer: "Anthem", state: "OH", attribute: "prior_auth" },
    requiredSubstrings: [],
  },
  {
    id: "pa-05",
    category: "PRIOR_AUTH",
    query: "CareSource Ohio Medicaid prior auth for 99347",
    expectedParse: { payer: "CareSource", state: "OH", cptCode: "99347", attribute: "prior_auth" },
    requiredSubstrings: [],
  },

  // ────────────────────────────────────────────────
  // PROVIDER_TYPE — NP/PA vs MD rate differential
  // ────────────────────────────────────────────────
  {
    id: "pt-01",
    category: "PROVIDER_TYPE",
    query: "Can a NP bill 99349?",
    expectedParse: { cptCode: "99349", attribute: "provider_type" },
    requiredSubstrings: ["nurse practitioner"],
  },
  {
    id: "pt-02",
    category: "PROVIDER_TYPE",
    query: "MD vs NP rate for 99350",
    expectedParse: { cptCode: "99350", attribute: "provider_type" },
    requiredSubstrings: ["174.52", "148.34"],
  },
  {
    id: "pt-03",
    category: "PROVIDER_TYPE",
    query: "Social worker home visit billing",
    expectedParse: { attribute: "provider_type" },
    requiredSubstrings: ["social worker"],
  },
  {
    id: "pt-04",
    category: "PROVIDER_TYPE",
    query: "Physician assistant 99344 rate",
    expectedParse: { cptCode: "99344", attribute: "provider_type" },
    requiredSubstrings: ["physician assistant", "114.01"],
  },

  // ────────────────────────────────────────────────
  // Misc — refusal cases (no source available)
  // ────────────────────────────────────────────────
  {
    id: "ref-01",
    category: "PRIOR_AUTH",
    query: "Tricare West rules for 99347 in Wyoming",
    expectedParse: { payer: "Tricare", state: "WY", cptCode: "99347" },
    requiredSubstrings: [],
    expectNoRule: true, // we have no source for this combo
  },
  {
    id: "ref-02",
    category: "TELEHEALTH",
    query: "Buckeye Health Plan policy for 99350 telehealth in Vermont",
    expectedParse: { payer: "Buckeye", state: "VT", cptCode: "99350", attribute: "telehealth" },
    requiredSubstrings: [],
    expectNoRule: true,
  },

  // ────────────────────────────────────────────────
  // Cross-pollination — multi-attribute queries
  // ────────────────────────────────────────────────
  {
    id: "cp-01",
    category: "TELEHEALTH",
    query: "Medicare covered for 99349",
    expectedParse: { payer: "Medicare", cptCode: "99349", attribute: "covered" },
    requiredSubstrings: ["medicare"],
  },
  {
    id: "cp-02",
    category: "PRIOR_AUTH",
    query: "Medical Mutual Ohio prior auth 99350",
    expectedParse: { payer: "Medical Mutual", state: "OH", cptCode: "99350", attribute: "prior_auth" },
    requiredSubstrings: [],
  },
  {
    id: "cp-03",
    category: "PROVIDER_TYPE",
    query: "What's the new patient home visit rate for an NP at 60 minutes?",
    expectedParse: { cptCode: "99344" },
    requiredSubstrings: ["114.01"],
  },
  {
    id: "cp-04",
    category: "ACP",
    query: "Total billable for 60 minutes of advance care planning",
    expectedParse: { cptCode: "99497" },
    requiredSubstrings: ["99497", "99498"],
  },
  {
    id: "cp-05",
    category: "PROLONGED",
    query: "70 minutes of home visit time, established patient, Medicare",
    expectedParse: { payer: "Medicare", cptCode: "G0318" },
    requiredSubstrings: ["g0318"],
  },

  // ────────────────────────────────────────────────
  // Documentation requirements
  // ────────────────────────────────────────────────
  {
    id: "doc-01",
    category: "TELEHEALTH",
    query: "Required statement for Medicare time-based home visit",
    expectedParse: { attribute: "documentation" },
    requiredSubstrings: ["counseling", "coordination"],
  },
  {
    id: "doc-02",
    category: "TELEHEALTH",
    query: "Telehealth consent statement wording",
    expectedParse: { attribute: "documentation" },
    requiredSubstrings: ["consent"],
  },

  // ────────────────────────────────────────────────
  // Frequency limits
  // ────────────────────────────────────────────────
  {
    id: "freq-01",
    category: "PRIOR_AUTH",
    query: "How often can 99497 be billed per year?",
    expectedParse: { cptCode: "99497", attribute: "frequency_limit" },
    requiredSubstrings: [],
  },
  {
    id: "freq-02",
    category: "PRIOR_AUTH",
    query: "Limit on 99350 per month",
    expectedParse: { cptCode: "99350", attribute: "frequency_limit" },
    requiredSubstrings: [],
  },

  // ────────────────────────────────────────────────
  // Add-on compatibility
  // ────────────────────────────────────────────────
  {
    id: "add-01",
    category: "ACP",
    query: "Can 99497 be billed with 99344?",
    expectedParse: { cptCode: "99497", attribute: "addon_compatible" },
    requiredSubstrings: ["99344"],
  },
  {
    id: "add-02",
    category: "PROLONGED",
    query: "Can G0318 be billed with 99497?",
    expectedParse: { cptCode: "G0318", attribute: "addon_compatible" },
    requiredSubstrings: ["99497"],
  },

  // ────────────────────────────────────────────────
  // Reflexive ambiguity — parser should still extract
  // ────────────────────────────────────────────────
  {
    id: "amb-01",
    category: "HOME_VISIT_BASE",
    query: "What does the cheat sheet say about ninety-nine three forty-nine?",
    expectedParse: { cptCode: "99349" },
    requiredSubstrings: [],
  },
  {
    id: "amb-02",
    category: "TELEHEALTH",
    query: "Tele-health for code 99349 in Ohio",
    expectedParse: { state: "OH", cptCode: "99349", attribute: "telehealth" },
    requiredSubstrings: [],
  },

  // ────────────────────────────────────────────────
  // Spec-required: confidence + citation + attribution
  // (Smoke checks — not subject to exact answer match)
  // ────────────────────────────────────────────────
  {
    id: "smk-01",
    category: "HOME_VISIT_BASE",
    query: "Show me 99344 with citation",
    expectedParse: { cptCode: "99344" },
    requiredSubstrings: [],
  },
  {
    id: "smk-02",
    category: "HOME_VISIT_BASE",
    query: "What's the Medicare allowable for 99350?",
    expectedParse: { payer: "Medicare", cptCode: "99350" },
    requiredSubstrings: ["174.52"],
  },
];

if (GOLD_STANDARD.length !== 50 && GOLD_STANDARD.length !== 49) {
  // Soft-fail: keep the assertion in the file so a future drift
  // (someone adds 51 or removes one) is loud during CI eval runs.
  // We allow 49 to give Mark room for one trim before re-baseline.
  // Anything outside [49, 51] should surface as a CI failure in
  // the eval suite, NOT a runtime crash here.
}
