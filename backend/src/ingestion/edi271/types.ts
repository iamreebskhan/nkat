/**
 * X12 271 — Eligibility, Coverage or Benefit Inquiry Response.
 *
 * Subset for our use case (verifying eligibility before pre-flight):
 *   - subscriber identity (PHI-safe: id only, no names)
 *   - active/inactive status
 *   - coverage period
 *   - benefit lines (EB segments) with:
 *       eligibility code (1=Active, 6=Inactive, 7=Expired, etc.)
 *       service type code (30=Health Benefit Plan, MH=Mental Health, AL=Alcoholism, ...)
 *       in/out network indicator
 *       copay / deductible / out-of-pocket dollar amounts
 *
 * The parser is PHI-aware: it never stores subscriber name fields, only the
 * identifier (member_id) — same posture as the 835 parser.
 */
export interface Edi271BenefitLine {
  /** EB01: 1 = Active Coverage, 6 = Inactive, 7 = Expired, V = Cannot Process, etc. */
  eligibility_code: string;
  /** EB02: U = Subscriber, F = Spouse, etc. */
  coverage_level?: string;
  /** EB03: 30 = Health Benefit Plan Coverage, MH, AL, AD, BH, etc. */
  service_type_codes: string[];
  /** EB04: HM = HMO, PR = PPO, etc. */
  insurance_type_code?: string;
  /** EB06: 26 = Exceeded, 28 = Remaining, 29 = Used, 27 = Year-to-date, 22 = Period start, 23 = Period end, 32 = Calendar year. */
  time_period_qualifier?: string;
  /** EB07: dollar amount. */
  monetary_amount?: number;
  /** EB09: percentage (0..100). */
  percent?: number;
  /** EB10: quantity. */
  quantity?: number;
  /** EB12: Y/N — in network. */
  in_plan_network?: 'Y' | 'N';
  /** Free-text description of the benefit (MSG segment). */
  message_text?: string[];
}

export interface Edi271SubscriberCoverage {
  /** Subscriber id (e.g. member_id). */
  subscriber_id?: string;
  /** Group / employer id. */
  group_id?: string;
  /** Coverage start date. */
  coverage_start?: Date;
  /** Coverage end date (NULL = open-ended). */
  coverage_end?: Date;
  benefits: Edi271BenefitLine[];
}

export interface Edi271Header {
  trace_number?: string;
  payer_name?: string;
  provider_name?: string;
}

export interface Edi271File {
  header: Edi271Header;
  subscribers: Edi271SubscriberCoverage[];
  unparsed_segments: string[];
}
