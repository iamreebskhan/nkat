/**
 * Hand-written Kysely table interfaces matching db/migrations/.
 *
 * Convention: TypeScript fields use snake_case to match the SQL column names.
 * For columns that have DB defaults or are GENERATED, we use Kysely's
 * `Generated<T>` so that INSERTs don't require them.
 */
import type { Generated, GeneratedAlways } from 'kysely';

// ----------------------------------------------------------------------------
// Reference taxonomies (global; no RLS)
// ----------------------------------------------------------------------------
export interface CodeRow {
  code: string;
  code_system: 'CPT' | 'HCPCS2';
  short_descriptor: string;
  category: string | null;
  effective_date: Date;
  expiration_date: Date | null;
  superseded_by: string | null;
  created_at: Generated<Date>;
  is_sud_part2: Generated<boolean>;
  specialty: string | null;
}

export type MhpaeaClassification =
  | 'inpatient_in_network'
  | 'inpatient_out_of_network'
  | 'outpatient_in_network'
  | 'outpatient_out_of_network'
  | 'emergency_care'
  | 'prescription_drugs';

export interface MhpaeaParityPairRow {
  id: Generated<string>;
  behavioral_health_code: string;
  med_surg_code: string;
  classification: MhpaeaClassification;
  rationale: string | null;
  source_url: string | null;
  effective_date: Date;
  expiration_date: Date | null;
}

export type ModifierType =
  | 'pricing'
  | 'informational'
  | 'distinct_service'
  | 'telehealth'
  | 'abn'
  | 'dme'
  | 'drug';

export interface ModifierRow {
  modifier: string;
  description: string;
  modifier_type: ModifierType;
  payer_applicability: string[];
  effective_date: Date;
  expiration_date: Date | null;
}

export type ModifierRelationshipType =
  | 'preferred_over'
  | 'mutually_exclusive'
  | 'required_with'
  | 'incompatible_with';

export interface ModifierRelationshipRow {
  id: Generated<string>;
  modifier_a: string;
  modifier_b: string;
  relationship_type: ModifierRelationshipType;
  rationale: string | null;
  source_url: string | null;
  effective_date: Date;
  expiration_date: Date | null;
}

export interface PosRow {
  pos: string;
  description: string;
  facility_indicator: 'facility' | 'non_facility';
  effective_date: Date;
  expiration_date: Date | null;
}

export interface Icd10Row {
  code: string;
  description: string;
  billable: boolean;
  chapter: string | null;
  effective_date: Date;
  expiration_date: Date | null;
}

export interface ProviderTaxonomyRow {
  taxonomy: string;
  classification: string;
  specialization: string | null;
  grouping: string;
  effective_date: Date;
  expiration_date: Date | null;
}

export interface RevenueCodeRow {
  code: string;
  description: string;
  category: string;
  setting: string[];
  effective_date: Date;
  expiration_date: Date | null;
}

export interface MsDrgRow {
  code: string;
  description: string;
  mdc: string;
  drg_type: 'medical' | 'surgical';
  relative_weight: string; // numeric → string for precision
  geometric_mean_los: string | null;
  arithmetic_mean_los: string | null;
  fy_version: string;
  effective_date: Date;
  expiration_date: Date | null;
}

export interface NdcRow {
  ndc11: string;
  proprietary_name: string | null;
  nonproprietary_name: string | null;
  hcpcs_jcode: string | null;
  unit_size_ml: string | null;
  units_per_package: number | null;
  effective_date: Date;
  expiration_date: Date | null;
}

export interface HccMappingRow {
  icd10: string;
  hcc_version: string;
  hcc_code: string;
  category: string | null;
  rxhcc_code: string | null;
  raf_weight: string | null;
  effective_year: number;
}

// ----------------------------------------------------------------------------
// Payers + rules
// ----------------------------------------------------------------------------
export interface StateRow {
  state: string;
  name: string;
  region: string | null;
  mac_jurisdiction: string | null;
}

export interface ProductLineRow {
  product_line: string;
  description: string;
  claim_form_type: 'professional' | 'institutional' | 'either';
}

export type PayerType =
  | 'medicare_mac'
  | 'medicare_advantage_org'
  | 'medicaid_state'
  | 'medicaid_mco'
  | 'commercial'
  | 'tpa'
  | 'workers_comp'
  | 'auto_no_fault'
  | 'tribal'
  | 'self_insured'
  | 'other';

export interface PayerRow {
  id: Generated<string>;
  name: string;
  parent_org: string | null;
  payer_type: PayerType;
  states_served: string[];
  npi: string | null;
  external_payer_id: string | null;
  policy_index_url: string | null;
  notes: string | null;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export type SourceDocumentType =
  | 'medical_policy'
  | 'reimbursement_policy'
  | 'provider_manual'
  | 'mln_article'
  | 'ncd'
  | 'lcd'
  | 'lcd_article'
  | 'cms_pfs'
  | 'cms_coverage_api'
  | 'hcpcs_release'
  | 'ncci_release'
  | 'analyst_call'
  | 'client_upload'
  | 'cms_0057_pa_api'
  | 'state_medicaid_manual'
  | 'wc_fee_schedule'
  | 'ihs_rate'
  | 'cms_final_rule';

export interface SourceDocumentRow {
  id: Generated<string>;
  payer_id: string | null;
  url: string;
  document_type: SourceDocumentType;
  title: string | null;
  effective_date: Date | null;
  retrieved_at: Date;
  content_hash: string;
  storage_uri: string | null;
  cms_license_token_used: Generated<boolean>;
  source_metadata: Record<string, unknown>;
  extracted_at: Date | null;
  extraction_candidate_count: Generated<number>;
  extraction_error: string | null;
  extracted_text: string | null;
}

export interface DocumentationRequirementRow {
  id: Generated<string>;
  code: string;
  payer_id: string | null;
  state: string | null;
  product_line: string | null;
  time_total_minutes_min: number | null;
  time_components: string[];
  mdm_elements: string[];
  required_phrases: string[];
  required_chart_elements: string[];
  rpm_days_data_required_min: number | null;
  source_doc_id: string | null;
  effective_date: Date;
  expiration_date: Date | null;
  created_at: Generated<Date>;
}

export type PayerRuleAttribute =
  | 'covered'
  | 'telehealth_allowed'
  | 'pos_allowed'
  | 'modifier_required'
  | 'modifier_optional'
  | 'modifier_combinations'
  | 'frequency_limit'
  | 'prior_auth_required'
  | 'medical_necessity_icd10'
  | 'bundled_with'
  | 'documentation_required'
  | 'provider_taxonomy_allowed'
  | 'timely_filing_days'
  | 'mhpaea_paired_code'
  | 'place_of_service_payment'
  | 'revenue_code_allowed'
  | 'surprise_billing_protected'
  | 'abn_recommended'
  | 'units_per_period_max'
  | 'copay_or_costshare';

export type CoverageStatus = 'covered' | 'not_covered' | 'varies' | 'unknown';

export interface PayerRuleRow {
  id: Generated<string>;
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  value: Record<string, unknown>;
  coverage_status: CoverageStatus;
  confidence: string;
  effective_date: Date;
  expiration_date: Date | null;
  superseded_by: string | null;
  source_doc_id: string;
  source_quote: string | null;
  source_page: number | null;
  documentation_requirement_id: string | null;
  provider_taxonomy_allowed: string[];
  timely_filing_days: number | null;
  mhpaea_paired_code: string | null;
  created_at: Generated<Date>;
  created_by: string;
}

export interface NcciPtpRow {
  id: Generated<string>;
  column1_code: string;
  column2_code: string;
  modifier_indicator: 0 | 1 | 9;
  edit_type: 'practitioner' | 'hospital_outpatient';
  effective_date: Date;
  expiration_date: Date | null;
  rationale: string | null;
  source_release: string;
}

export interface NcciMueRow {
  id: Generated<string>;
  code: string;
  setting: 'practitioner' | 'outpatient_hospital' | 'dme';
  units_max: number;
  rationale: string | null;
  effective_date: Date;
  expiration_date: Date | null;
  source_release: string;
}

export interface CobRuleRow {
  id: Generated<string>;
  coverage_type_a: string;
  coverage_type_b: string;
  primary_position: 'A' | 'B' | 'depends' | 'tie_other_rules';
  conditions: Record<string, unknown>;
  rationale: string | null;
  source_url: string | null;
  effective_date: Date;
  expiration_date: Date | null;
}

// ----------------------------------------------------------------------------
// Document chunks
// ----------------------------------------------------------------------------
export interface DocumentChunkRow {
  id: Generated<string>;
  source_doc_id: string;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  payer_id: string | null;
  state: string | null;
  codes_mentioned: string[];
  icd10_mentioned: string[];
  modifiers_mentioned: string[];
  pos_mentioned: string[];
  taxonomy_mentioned: string[];
  policy_section: string | null;
  token_count: number | null;
  created_at: Generated<Date>;
  content_tsv: GeneratedAlways<unknown>;
}

// ----------------------------------------------------------------------------
// Tenant tables (RLS-protected)
// ----------------------------------------------------------------------------
export interface OrgRow {
  id: Generated<string>;
  name: string;
  slug: string;
  plan_tier: 'solo' | 'team' | 'org' | 'enterprise';
  baa_signed_at: Date | null;
  baa_document_uri: string | null;
  primary_contact_email: string | null;
  status: 'active' | 'suspended' | 'closed';
  metadata: Record<string, unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AppUserRow {
  id: Generated<string>;
  email: string;
  full_name: string | null;
  password_hash: string | null;
  mfa_secret: string | null;
  mfa_enrolled_at: Date | null;
  status: 'active' | 'suspended' | 'deleted';
  last_login_at: Date | null;
  created_at: Generated<Date>;
}

export interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: 'employee' | 'reviewer' | 'admin' | 'consultant';
  invited_at: Generated<Date>;
  invited_by: string | null;
  joined_at: Date | null;
  status: 'invited' | 'active' | 'suspended' | 'removed';
}

export interface ClientCompanyRow {
  id: Generated<string>;
  org_id: string;
  name: string;
  npi: string | null;
  primary_state: string | null;
  specialties: string[];
  metadata: Record<string, unknown>;
  created_at: Generated<Date>;
}

export interface ClientRulebookRow {
  id: Generated<string>;
  org_id: string;
  client_id: string;
  version: number;
  status: 'draft' | 'review' | 'finalized' | 'archived';
  finalized_at: Date | null;
  finalized_by: string | null;
  parent_version_id: string | null;
  source_doc_ids: string[];
  notes: string | null;
  integrity_hash: string | null;
  created_at: Generated<Date>;
}

export interface ClientRuleRow {
  id: Generated<string>;
  org_id: string;
  rulebook_id: string;
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  value: Record<string, unknown>;
  decision: 'accept_authoritative' | 'keep_client' | 'edit_custom' | 'intentional_deviation';
  decision_note: string | null;
  authoritative_rule_id: string | null;
  decided_by: string | null;
  decided_at: Generated<Date>;
}

export interface AuditLogRow {
  id: Generated<string>;
  org_id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  occurred_at: Generated<Date>;
}

export interface ConsentRecordRow {
  id: Generated<string>;
  org_id: string;
  client_id: string;
  patient_external_id: string;
  scope: string[];
  granted_at: Date;
  revoked_at: Date | null;
  document_uri: string | null;
  source: string;
  notes: string | null;
}

export type AlertType =
  | 'rule_change'
  | 'new_diff'
  | 'source_expired'
  | 'consent_required'
  | 'attestation_expiring'
  | 'extraction_drift'
  | 'source_unavailable';

export interface AlertRow {
  id: Generated<string>;
  org_id: string;
  client_id: string | null;
  rulebook_id: string | null;
  alert_type: AlertType;
  severity: 'critical' | 'high' | 'medium' | 'info';
  payload: Record<string, unknown>;
  related_rule_id: string | null;
  created_at: Generated<Date>;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  auto_resolved_at: Date | null;
}

export interface Era835RecordRow {
  id: Generated<string>;
  org_id: string;
  client_id: string;
  payer_id: string | null;
  trace_number: string | null;
  claim_id: string | null;
  patient_external_id: string | null;
  service_dos: Date;
  billed_amount: string | null;
  paid_amount: string | null;
  adjustment_amount: string | null;
  carc_codes: string[];
  rarc_codes: string[];
  group_code: string | null;
  service_codes: string[];
  modifiers: string[];
  pos: string | null;
  units: number | null;
  expected_rule_id: string | null;
  preflight_warned: boolean;
  raw_segment: string | null;
  source_file_uri: string | null;
  ingested_at: Generated<Date>;
}

export interface DenialEventRow {
  id: Generated<string>;
  org_id: string;
  client_id: string | null;
  payer_id: string | null;
  code: string | null;
  carc: string;
  rarc: string | null;
  count: number;
  dollar_impact: string;
  preflight_caught_count: number;
  preflight_caught_dollar: string;
  period: string; // daterange serialized
  computed_at: Generated<Date>;
}

export interface AbnRecordRow {
  id: Generated<string>;
  org_id: string;
  client_id: string;
  patient_external_id: string;
  form_version: string;
  signed_at: Date;
  service_codes: string[];
  reason_code: string | null;
  estimated_cost: string | null;
  document_uri: string | null;
  retain_until: Date;
  notes: string | null;
  created_at: Generated<Date>;
}

// ----------------------------------------------------------------------------
// Extraction queue (Phase 2)
// ----------------------------------------------------------------------------
export type ExtractionStatus =
  | 'queued'
  | 'claimed'
  | 'accepted'
  | 'rejected'
  | 'edited'
  | 'superseded'
  | 'withdrawn';

export interface ExtractionCandidateRow {
  id: Generated<string>;
  source_doc_id: string;
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  proposed_value: Record<string, unknown>;
  proposed_coverage_status: CoverageStatus;
  proposed_confidence: string;
  proposed_effective_date: Date;
  proposed_expiration_date: Date | null;
  proposed_provider_taxonomy_allowed: string[];
  proposed_timely_filing_days: number | null;
  proposed_mhpaea_paired_code: string | null;
  source_quote: string | null;
  source_page: number | null;
  extractor_name: string;
  extractor_run_id: string | null;
  status: Generated<ExtractionStatus>;
  priority: Generated<number>;
  claimed_by: string | null;
  claimed_at: Date | null;
  resulting_rule_id: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ExtractionDecisionKind = 'accept' | 'reject' | 'edit' | 'withdraw';

export interface ExtractionDecisionRow {
  id: Generated<string>;
  candidate_id: string;
  decision: ExtractionDecisionKind;
  edited_value: Record<string, unknown> | null;
  edited_coverage_status: CoverageStatus | null;
  edited_confidence: string | null;
  rationale: string | null;
  attestation_call: Record<string, unknown> | null;
  decided_by: string;
  decided_at: Generated<Date>;
}

export interface RuleDisputeRow {
  id: Generated<string>;
  org_id: string;
  user_id: string | null;
  payer_rule_id: string | null;
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  attribute: PayerRuleAttribute;
  customer_assertion: Record<string, unknown>;
  evidence_url: string | null;
  customer_notes: string | null;
  status: Generated<
    'open' | 'investigating' | 'resolved_we_were_right' | 'resolved_we_were_wrong' | 'withdrawn'
  >;
  resulting_candidate_id: string | null;
  resolution_notes: string | null;
  created_at: Generated<Date>;
  resolved_at: Date | null;
}

// ----------------------------------------------------------------------------
// Phase 3 — reconciliation, redaction, webhooks, re-verification
// ----------------------------------------------------------------------------
export type ClientDocUploadStatus =
  | 'received'
  | 'redacting'
  | 'redacted'
  | 'extracted'
  | 'rejected'
  | 'expired';

export interface ClientDocUploadRow {
  id: Generated<string>;
  org_id: string;
  client_id: string;
  uploaded_by: string | null;
  original_filename: string;
  content_type: string | null;
  byte_size: string; // BIGINT serialized as string by pg
  raw_storage_uri: string | null;
  redacted_text: string | null;
  redacted_storage_uri: string | null;
  redaction_summary: Record<string, unknown>;
  source_document_id: string | null;
  status: Generated<ClientDocUploadStatus>;
  notes: string | null;
  created_at: Generated<Date>;
}

export interface RedactionEventRow {
  id: Generated<string>;
  org_id: string;
  upload_id: string;
  redactor_name: string;
  redactor_version: string;
  category_counts: Record<string, number>;
  total_redactions: number;
  performed_at: Generated<Date>;
  performed_by: string;
}

export type WebhookEventType =
  | 'alert.created'
  | 'rulebook.finalized'
  | 'rule.changed'
  | 'rule.disputed'
  | 'dispute.resolved'
  | 'attestation.expiring'
  | 'extraction.candidate.queued';

export interface WebhookSubscriptionRow {
  id: Generated<string>;
  org_id: string;
  url: string;
  signing_secret: string;
  event_types: WebhookEventType[];
  status: Generated<'active' | 'paused' | 'disabled'>;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  consecutive_failures: Generated<number>;
  created_at: Generated<Date>;
}

export type WebhookDeliveryStatus = 'queued' | 'in_flight' | 'succeeded' | 'failed' | 'dead_letter';

export interface WebhookDeliveryRow {
  id: Generated<string>;
  org_id: string;
  subscription_id: string;
  event_id: string;
  event_type: WebhookEventType;
  payload: Record<string, unknown>;
  signature: string;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  ready_at: Date | null;
  last_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  status: Generated<WebhookDeliveryStatus>;
  created_at: Generated<Date>;
}

export interface AttestationReverificationRow {
  id: Generated<string>;
  payer_rule_id: string;
  reverify_by: Date;
  status: Generated<'pending' | 'completed' | 'overdue' | 'superseded'>;
  completed_at: Date | null;
  completed_by: string | null;
  created_at: Generated<Date>;
}

// ----------------------------------------------------------------------------
// Database type used by Kysely
// ----------------------------------------------------------------------------
export interface Database {
  // reference
  code: CodeRow;
  modifier: ModifierRow;
  modifier_relationship: ModifierRelationshipRow;
  pos: PosRow;
  icd10: Icd10Row;
  provider_taxonomy: ProviderTaxonomyRow;
  revenue_code: RevenueCodeRow;
  ms_drg: MsDrgRow;
  ndc: NdcRow;
  hcc_mapping: HccMappingRow;
  state: StateRow;
  product_line: ProductLineRow;
  payer: PayerRow;
  source_document: SourceDocumentRow;
  documentation_requirement: DocumentationRequirementRow;
  payer_rule: PayerRuleRow;
  ncci_ptp: NcciPtpRow;
  ncci_mue: NcciMueRow;
  cob_rule: CobRuleRow;
  document_chunk: DocumentChunkRow;
  // tenant
  org: OrgRow;
  app_user: AppUserRow;
  org_member: OrgMemberRow;
  client_company: ClientCompanyRow;
  client_rulebook: ClientRulebookRow;
  client_rule: ClientRuleRow;
  audit_log: AuditLogRow;
  consent_record: ConsentRecordRow;
  alert: AlertRow;
  era_835_record: Era835RecordRow;
  denial_event: DenialEventRow;
  abn_record: AbnRecordRow;
  // Phase 2 extraction queue
  extraction_candidate: ExtractionCandidateRow;
  extraction_decision: ExtractionDecisionRow;
  rule_dispute: RuleDisputeRow;
  // Phase 3
  client_doc_upload: ClientDocUploadRow;
  redaction_event: RedactionEventRow;
  webhook_subscription: WebhookSubscriptionRow;
  webhook_delivery: WebhookDeliveryRow;
  attestation_reverification: AttestationReverificationRow;
  // Phase 4
  mhpaea_parity_pair: MhpaeaParityPairRow;
  // Phase 5
  dme_master_list: DmeMasterListRow;
  wc_state_fee_schedule: WcStateFeeScheduleRow;
  cms_0057_pa_response: Cms0057PaResponseRow;
  ihs_encounter_rate: IhsEncounterRateRow;
  // Phase 6
  feature_flag: FeatureFlagRow;
  asc_payment_indicator: AscPaymentIndicatorRow;
  ub04_bill_type: Ub04BillTypeRow;
  revenue_code_product_line: RevenueCodeProductLineRow;
  // Phase 11
  subscription: SubscriptionRow;
  billing_event: BillingEventRow;
  // Phase 15
  signup_attempt: SignupAttemptRow;
  // Phase 16
  invite_token: InviteTokenRow;
  // Phase 17
  email_send: EmailSendRow;
  email_suppression: EmailSuppressionRow;
  // Phase 22
  idempotency_record: IdempotencyRecordRow;
  // Phase 24
  synthesis_cache: SynthesisCacheRow;
  // Phase 25
  system_setting: SystemSettingRow;
  // Phase 34
  tenant_deletion_request: TenantDeletionRequestRow;
  audit_log_redaction: AuditLogRedactionRow;
  // Phase 35
  rate_limit_override: RateLimitOverrideRow;
  // Phase 42
  scim_token: ScimTokenRow;
  // Phase 46
  privacy_consent: PrivacyConsentRow;
  dsar_request: DsarRequestRow;
  // Phase 64
  tenant_clearinghouse_credential: TenantClearinghouseCredentialRow;
}

export type Clearinghouse = 'availity' | 'change_healthcare' | 'waystar';

export interface TenantClearinghouseCredentialRow {
  id: Generated<string>;
  org_id: string;
  clearinghouse: Clearinghouse;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: Generated<number>;
  display_suffix: string;
  label: string | null;
  created_by_user_id: string | null;
  last_verified_at: Date | null;
  last_verification_status: 'ok' | 'failed' | null;
  last_verification_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PrivacyRegime =
  | 'wmhmda'
  | 'ccpa'
  | 'cpa_co'
  | 'tdpsa_tx'
  | 'vcdpa_va'
  | 'ab3030_ai'
  | 'sb24_205_ai_co'
  | 'general';

export interface PrivacyConsentRow {
  id: Generated<string>;
  org_id: string;
  user_id: string | null;
  subject_external_id: string | null;
  regime: PrivacyRegime;
  notice_version: string;
  granted: boolean;
  ip_address: string | null;
  user_agent: string | null;
  granted_at: Generated<Date>;
  revoked_at: Date | null;
}

export type DsarRegime =
  | 'wmhmda'
  | 'ccpa'
  | 'cpa_co'
  | 'tdpsa_tx'
  | 'vcdpa_va'
  | 'ctdpa_ct'
  | 'utah_ucpa'
  | 'general';

export type DsarRequestType =
  | 'access'
  | 'deletion'
  | 'portability'
  | 'correction'
  | 'opt_out_sale'
  | 'opt_out_targeted_advertising'
  | 'limit_sensitive_use';

export type DsarStatus = 'received' | 'verified' | 'fulfilled' | 'rejected' | 'expired';

export interface DsarRequestRow {
  id: Generated<string>;
  org_id: string;
  user_id: string | null;
  subject_email: string | null;
  subject_name: string | null;
  regime: DsarRegime;
  request_type: DsarRequestType;
  status: Generated<DsarStatus>;
  due_at: Date;
  fulfilled_at: Date | null;
  rejection_reason: string | null;
  notes: string | null;
  ip_address: string | null;
  user_agent: string | null;
  received_at: Generated<Date>;
}

export interface ScimTokenRow {
  id: Generated<string>;
  org_id: string;
  token_hash: string;
  display_suffix: string;
  description: string | null;
  created_by_user_id: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Generated<Date>;
}

export interface RateLimitOverrideRow {
  org_id: string;
  scope: string;
  limit: number;
  refill_per_sec: string; // NUMERIC arrives as string from pg
  reason: string | null;
  set_by_user_id: string | null;
  expires_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type TenantDeletionStatus = 'requested' | 'scheduled' | 'executed' | 'canceled' | 'failed';

export interface TenantDeletionRequestRow {
  id: Generated<string>;
  org_id: string;
  status: Generated<TenantDeletionStatus>;
  earliest_execute_at: Date;
  executed_at: Date | null;
  canceled_at: Date | null;
  failure_reason: string | null;
  requested_by_user_id: string | null;
  confirmation_phrase: string;
  reason: string | null;
  retain_audit_log: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface AuditLogRedactionRow {
  id: Generated<string>;
  org_id: string;
  audit_log_id: string;
  redacted_by_user_id: string;
  reason: string;
  redaction_type: 'payload_scrub' | 'payload_remove';
  original_payload_hash: string;
  redacted_at: Generated<Date>;
}

export interface SystemSettingRow {
  key: string;
  value: unknown;
  updated_by_user_id: string | null;
  note: string | null;
  updated_at: Generated<Date>;
}

export interface SynthesisCacheRow {
  org_id: string;
  content_hash: string;
  result: Record<string, unknown>;
  provider: string;
  hit_count: Generated<number>;
  last_hit_at: Date | null;
  created_at: Generated<Date>;
  expires_at: Generated<Date>;
}

export interface IdempotencyRecordRow {
  org_id: string;
  key: string;
  request_hash: string;
  response_status: number;
  response_body: Record<string, unknown>;
  created_at: Generated<Date>;
  expires_at: Generated<Date>;
}

export type EmailSendStatus = 'queued' | 'sent' | 'suppressed' | 'failed';

export interface EmailSendRow {
  id: Generated<string>;
  org_id: string | null;
  template: string;
  recipient: string;
  subject: string;
  status: EmailSendStatus;
  provider_message_id: string | null;
  error_class: string | null;
  error_detail: string | null;
  idempotency_key: string | null;
  created_at: Generated<Date>;
  sent_at: Date | null;
  // Phase 20
  args_snapshot: Generated<Record<string, unknown>>;
  retry_count: Generated<number>;
  next_retry_at: Date | null;
}

export type EmailSuppressionReason =
  | 'bounce_permanent'
  | 'bounce_transient'
  | 'complaint'
  | 'manual_optout'
  | 'admin_block';

export interface EmailSuppressionRow {
  email: string;
  reason: EmailSuppressionReason;
  source: 'ses_feedback' | 'manual' | 'admin_api';
  detail: string | null;
  suppressed_at: Generated<Date>;
  expires_at: Date | null;
}

export interface InviteTokenRow {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  token_lookup_prefix: string;
  token_hash: string;
  role: 'employee' | 'reviewer' | 'admin' | 'consultant';
  expires_at: Date;
  consumed_at: Date | null;
  consumed_ip: string | null;
  issued_by: string | null;
  created_at: Generated<Date>;
}

export type SignupAttemptStatus = 'pending' | 'completed' | 'abandoned' | 'expired';

export interface SignupAttemptRow {
  id: Generated<string>;
  org_id: string;
  company_name: string;
  admin_email: string;
  tier: 'solo' | 'team' | 'org';
  quantity: number;
  states: string[];
  specialty_packs: string[];
  trial_days: Generated<number>;
  stripe_checkout_session_id: string;
  status: Generated<SignupAttemptStatus>;
  source_ip: string | null;
  source_user_agent: string | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
  expires_at: Generated<Date>;
}

// ----------------------------------------------------------------------------
// Phase 11 — Stripe-backed billing
// ----------------------------------------------------------------------------
export type SubscriptionTier = 'solo' | 'team' | 'org' | 'enterprise';
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export interface SubscriptionRow {
  id: Generated<string>;
  org_id: string;
  tier: SubscriptionTier;
  seats: number;
  states: string[];
  specialty_packs: string[];
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: Generated<SubscriptionStatus>;
  current_period_start: Date | null;
  current_period_end: Date | null;
  trial_end: Date | null;
  cancel_at_period_end: Generated<boolean>;
  metadata: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BillingEventRow {
  id: Generated<string>;
  org_id: string;
  stripe_event_id: string;
  event_type: string;
  computed_state: Record<string, unknown>;
  raw_payload: Record<string, unknown>;
  occurred_at: Date;
  received_at: Generated<Date>;
}

// ----------------------------------------------------------------------------
// Phase 6 — feature flags, ASC fee schedule, UB-04 institutional validation
// ----------------------------------------------------------------------------
export interface FeatureFlagRow {
  flag_key: string;
  org_id: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  rationale: string | null;
  updated_at: Generated<Date>;
}

export interface AscPaymentIndicatorRow {
  code: string;
  payment_indicator: string;
  payment_group: string | null;
  payment_rate: string | null;
  effective_year: number;
  source_url: string | null;
}

export interface Ub04BillTypeRow {
  bill_type: string;
  facility_type: string;
  classification: string | null;
  frequency: string | null;
  description: string;
  valid_for_product_lines: string[];
  effective_date: Date;
  expiration_date: Date | null;
}

export interface RevenueCodeProductLineRow {
  revenue_code: string;
  product_line: string;
  valid: Generated<boolean>;
  rationale: string | null;
  effective_date: Date;
  expiration_date: Date | null;
}

// ----------------------------------------------------------------------------
// Phase 5 — DMEPOS, Workers' Comp, IHS, CMS-0057-F PA cache
// ----------------------------------------------------------------------------
export interface DmeMasterListRow {
  id: Generated<string>;
  code: string;
  description: string | null;
  requires_face_to_face: Generated<boolean>;
  requires_prior_auth: Generated<boolean>;
  requires_cmn: Generated<boolean>;
  payment_threshold_dollar: string | null;
  effective_date: Date;
  expiration_date: Date | null;
  source_release: string;
  source_url: string | null;
}

export interface WcStateFeeScheduleRow {
  state: string;
  year: number;
  conversion_factor: string;
  effective_date: Date;
  expiration_date: Date | null;
  adopts_cms_codes: Generated<boolean>;
  notes: string | null;
  source_url: string | null;
}

export interface Cms0057PaResponseRow {
  id: Generated<string>;
  org_id: string;
  payer_id: string | null;
  request_correlation_id: string;
  fhir_request_uri: string;
  fhir_response_status: number;
  fhir_response_body: Record<string, unknown>;
  pa_required: boolean | null;
  decision: 'approved' | 'denied' | 'pending' | 'unknown' | null;
  documentation_codes: string[];
  patient_external_id: string | null;
  service_codes: string[];
  date_of_service: Date | null;
  retrieved_at: Generated<Date>;
  resulting_candidate_id: string | null;
}

export interface IhsEncounterRateRow {
  id: Generated<string>;
  setting: 'outpatient' | 'inpatient_per_diem' | 'dental' | 'medicare_clinic';
  effective_year: number;
  amount: string;
  source_federal_register: string | null;
  notes: string | null;
}
