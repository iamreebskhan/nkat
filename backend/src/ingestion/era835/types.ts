/**
 * 835 ERA (Electronic Remittance Advice) parsed types.
 *
 * The X12 835 transaction set is documented at:
 *   https://x12.org/products/transaction-sets#835
 *
 * Our parser produces a subset that covers our denial-intelligence use case:
 *   - per-claim level: claim_id, dates, billed/paid/adjustment amounts,
 *     CARC + RARC codes, group code (CO/PR/OA/PI).
 *   - per-service-line level: service_code, modifiers, billed/paid amounts,
 *     line-level CARC adjustments.
 *
 * We deliberately keep this narrower than the full X12 spec — an analytics
 * use case doesn't need every NM1 / REF / DTM variant.
 */

export interface Era835Adjustment {
  /** CO=Contractual Obligation, PR=Patient Responsibility, OA=Other, PI=Payer Initiated. */
  group_code: 'CO' | 'PR' | 'OA' | 'PI';
  reason_code: string;          // CARC, e.g. "97", "11", "29", "16"
  amount: number;               // dollars; negative means we owe payer (recovery)
  quantity?: number | undefined;
}

export interface Era835ServiceLine {
  /** SVC01-2: typically a CPT/HCPCS, sometimes prefixed "HC:". */
  service_code: string;
  /** SVC01-3..6: up to 4 modifiers. */
  modifiers: string[];
  /** SVC02: original line-level billed amount. */
  billed_amount: number;
  /** SVC03: paid amount. */
  paid_amount: number;
  /** SVC05: original units. */
  units: number;
  /** SVC04 (revenue code) for institutional claims. */
  revenue_code?: string;
  /** Service start DOS from DTM*472 segment at line level. */
  service_dos?: Date;
  /** Line-level CAS adjustments (multiple groups possible). */
  adjustments: Era835Adjustment[];
  /** RARC remarks from LQ*HE segments. */
  rarc_codes: string[];
}

export interface Era835Claim {
  /** CLP01: claim ID — provider-assigned. */
  claim_id: string;
  /** CLP02: payer status code (1 processed as primary, 2 secondary, 3 tertiary, 4 denied, etc.). */
  status_code: string;
  /** CLP03: total billed. */
  billed_amount: number;
  /** CLP04: total paid. */
  paid_amount: number;
  /** CLP05: patient responsibility. */
  patient_responsibility?: number;
  /** Payer's claim control number from CLP07. */
  payer_claim_control_number?: string;
  /** Patient identifier carried in NM1*QC segment, hashed/de-identified upstream. */
  patient_external_id?: string;
  /** Claim-level service span; may differ from line-level DOS. */
  service_dos?: Date;
  /** Claim-level CAS adjustments. */
  adjustments: Era835Adjustment[];
  /** Claim-level RARC remarks. */
  rarc_codes: string[];
  /** All service lines on this claim. */
  service_lines: Era835ServiceLine[];
}

export interface Era835Header {
  /** TRN02: trace/reassociation reference. */
  trace_number?: string;
  /** BPR16: payment effective date. */
  payment_date?: Date;
  /** BPR02: total payment amount. */
  total_paid?: number;
  /** Payer name from N1*PR segment. */
  payer_name?: string;
  /** Payee/provider name from N1*PE segment. */
  payee_name?: string;
}

export interface Era835File {
  header: Era835Header;
  claims: Era835Claim[];
  /**
   * Anything we couldn't parse — preserved for debugging without polluting
   * the typed result. Each entry is the original segment string.
   */
  unparsed_segments: string[];
}
