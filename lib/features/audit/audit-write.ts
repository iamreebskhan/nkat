/**
 * Writing to the audit trail.
 *
 * WHY THIS EXISTS. A live walkthrough of production created a patient, signed
 * a visit and generated a superbill, then read the audit log back: 56 rows,
 * every one of them 'login'. Nothing that touched patient data was recorded
 * anywhere. HIPAA §164.312(b) asks for records of activity in systems holding
 * ePHI, and "who opened this chart, and who changed it" is the first question
 * asked after any incident — it cannot be reconstructed later from tables that
 * only keep the current value.
 *
 * The audit service next door only READS. There was no shared writer, so the
 * two places that did log rolled their own INSERT, and everywhere else simply
 * did not. That is the gap this closes.
 *
 * IN THE CALLER'S TRANSACTION, ON PURPOSE. Every writer here takes the `tx`
 * the action itself is using, so the audit row commits with the action or not
 * at all. A trail that can silently lose entries while the write it describes
 * succeeds is worse than no trail, because it looks complete. The one
 * exception is recordAuditDetached, for callers that have no transaction to
 * join (login, which must not fail because logging did).
 *
 * NO PHI IN THE PAYLOAD. Rows carry ids and field NAMES, never values — no
 * patient name, address, member id or note text. The payload says which
 * fields changed; the record itself says what they changed to, and that is
 * already access-controlled. An audit log that copies PHI just doubles the
 * amount of PHI to protect, and this one is readable by every org admin.
 */
import type { Prisma } from "@prisma/client";

import { withOrgContext } from "@/lib/db";

/**
 * Actions worth a row. Kept as a union so a typo cannot invent an action.
 *
 * READS ARE NOT IN HERE, DELIBERATELY. Opening a chart is already recorded by
 * logPhiAccess() into phi_access_log, a purpose-built table with its own
 * retention and its own §164.528 accounting. I briefly added a 'patient_view'
 * member here before finding that, which would have grown a second, competing
 * read log alongside the working one. Reads go to phi_access_log; this table
 * is for changes and for events an org admin reads day to day.
 */
export type AuditAction =
  | "login"
  /**
   * A session ended (0121): signed out by the person, or after the org's idle
   * limit passed with nothing done. Payload is the reason, a closed set.
   */
  | "logout"
  /**
   * A second factor set up (at sign-in, when the role requires one, or on
   * Settings → Security) or turned off (0121). Payload says which and where;
   * never the secret or a code.
   */
  | "mfa_change"
  | "patient_create"
  | "patient_update"
  | "patient_export"
  | "visit_document"
  | "visit_sign"
  /**
   * A visit that did not happen: cancelled, or the patient was a no-show.
   * Recorded as visit_document like any other status move until there was a
   * way to do either from the app, which read in the log as documentation.
   * Payload is the from/to status only.
   */
  | "visit_cancel"
  | "visit_no_show"
  | "visit_reschedule"
  /**
   * One visit booked. The row's user is who booked it; the visit names the
   * clinician it is for. Payload is whether it is telehealth, never the time.
   */
  | "visit_create"
  /** A repeating series booked (0126): how many visits and how often, never a date. */
  | "visit_series_create"
  /**
   * A visit's type corrected before sign-off, which moves the CPT band it is
   * coded on (a first visit booked as established bills 99347-99350 instead of
   * 99341-99345). Payload is the from/to coding bands — a closed set — and
   * whether the codes saved under the old band were cleared; never the org's
   * own type names or labels, which are free text.
   */
  | "visit_type_change"
  /**
   * Vitals recorded on a visit. Separate from visit_document because vitals
   * are the one part of the note that is also a longitudinal clinical record:
   * a weight the trend is drawn from, changed after the fact, is a different
   * question from a paragraph edited before signing. Payload carries the
   * field names touched, never the readings.
   */
  | "visit_vitals_record"
  /**
   * Note sections copied forward from a previous signed visit. Audited because
   * carried-forward text is the thing a payer looks for when it suspects a
   * cloned note — "which sections were brought forward, from which visit, and
   * by whom" has to be answerable years later.
   */
  | "visit_note_carry_forward"
  // An org changing its own note template. Worth an audit entry because it
  // changes what "a complete note" means for every visit signed afterwards.
  | "note_template_edit"
  // A clinician NPI or credential changed (audit R40, R25). It changes who
  // every later claim names as rendering provider, and its rate.
  | "clinician_profile_update"
  // What a member may do changed (audit R38): permission names, never PHI.
  | "team_permissions_update"
  // A correction signed onto an attested note (audit R15): ids and length only.
  | "visit_addendum"
  | "superbill_create"
  | "superbill_status_change"
  | "superbill_code_override"
  | "denial_decision"
  /**
   * A denied claim recorded as sent out again. Ids and whether the claim had
   * already gone back out (from the queue, or another denial on it) — the case
   * that wrote no audit row at all before.
   */
  | "denial_refile"
  // What finally happened to a denied claim (audit R24): outcome and amount only.
  | "denial_outcome"
  // A payer's 835 uploaded and posted (audit R10). Counts only: no claim id,
  // and nothing from the file's patient segment.
  | "remittance_post"
  | "rulebook_finalize"
  /**
   * Org configuration: visit types, visit services, branding. Added after a
   * visit type was switched off during testing and there was no way to find
   * out who did it or when — the row only carries its current state. These
   * settings decide what a clinician can even select when scheduling, so
   * "who turned this off" is a real question with no answer before this.
   */
  | "settings_update"
  /**
   * A payer added to, edited on, or withdrawn from the global roster (audit
   * R17). Platform-admin only, and it changes what every org bills against:
   * which plans intake can pick, and in which states. Payer data is reference
   * data, not PHI, so the payload names the payer and its states beside the
   * field names.
   */
  | "payer_roster_change"
  /**
   * A family member or caregiver added to, edited on, or removed from a chart
   * (audit R30). Who holds healthcare POA decides who may consent for the
   * patient, so "who recorded the nephew as POA, and when" must be answerable.
   * Contact id and field names only — never a name or phone number.
   */
  | "patient_contact_change"
  /**
   * An outside provider linked to or unlinked from a patient (audit R30): the
   * PCP, referrer and specialists the note header prints. Link id, provider
   * id and role only.
   */
  | "patient_provider_change"
  /**
   * The org's roster of outside providers changed (audit R30). One roster row
   * feeds every chart that links it, so a changed fax number reaches them all.
   * Provider id and field names only.
   */
  | "external_provider_change"
  /**
   * The intake pipeline (Level-1 doc:22-28, 0111): a referral received or
   * corrected, its stage moved (admitted, NTUC with its code, set aside), its
   * pending requirements ticked, a triage recorded. Referral id, field names,
   * stages, codes and counts — never the person's name or what triage found.
   */
  | "referral_create"
  | "referral_update"
  | "referral_stage"
  | "referral_requirements"
  | "referral_triage"
  /**
   * A check of a referral's or patient's coverage (doc:23): method and result,
   * which decide whether the visit is billable. Never the member id.
   */
  | "insurance_verification"
  // The practice's discharge and NTUC codes (0111): code and field names.
  | "reason_code_change"
  /**
   * A document kept on a referral or a chart (0112): uploaded, opened, or
   * removed as filed in error. Kind, type, size and the subject's ids — never
   * the file's name, which is often the patient's.
   */
  | "document_upload"
  | "document_view"
  | "document_remove"
  /**
   * The chart's problem, medication or allergy list changed, or "no known
   * allergies" was recorded (0114): which list, what was done (add, resolve,
   * stop, inactivate…), the item's id and the field names. Never the
   * diagnosis code, the drug or the substance.
   */
  | "clinical_list_change"
  /**
   * The course of care (0115): an acuity given at a visit (its source and the
   * level, a closed set), a hospice-eligibility assessment (yes or no), a
   * significant event recorded, corrected or voided (its kind), a discharge,
   * the hospice stay's outcome or a readmission (the practice's code number,
   * its category, the status). Never what was written about the patient.
   */
  | "acuity_change"
  | "hospice_assessment"
  | "patient_event_change"
  | "patient_discharge"
  /**
   * Care between visits (0116): a care-plan save (which parts, the version,
   * whether during a visit), a PCM/CCM enrolment or its end (the program), a
   * telephone encounter recorded or voided, an escalation alert raised,
   * withdrawn or acknowledged (the measure, a closed set — never the reading),
   * a task created, changed, done or cancelled (its discipline and the field
   * names — never its title or details).
   */
  | "care_plan_update"
  | "care_program_enrollment"
  | "phone_encounter"
  | "escalation_alert"
  | "care_task"
  /**
   * PCM/CCM (0117): time logged or voided (the program, practitioner or
   * clinical staff, minutes, the activity, whether from a call — never the
   * note), and a month's charge raised (the program, the code set, the CPT
   * codes and add-on units, the visit carrying it; never the diagnoses).
   */
  | "care_management_time"
  | "care_management_charge"
  /**
   * Claims exported for the billing software (0118): the batch, how many
   * claims and lines, and the claims' ids. Never what the file held.
   */
  | "claim_export"
  /**
   * A clearinghouse connection saved, tested, switched off or removed, or its
   * payer IDs set (0120): the vendor, the channels, the names of the settings
   * changed and of the secrets set or cleared — never a value, ID or host.
   */
  | "clearinghouse_connection"
  /**
   * An 837P file built (0120): sent over SFTP, failed to send, or downloaded.
   * The submission, its control numbers and how many claims — no patient.
   */
  | "claim_submission"
  /**
   * A response file read from a clearinghouse or uploaded (0120): its kind
   * and what it changed, in counts.
   */
  | "clearinghouse_file"
  /** A claim status question asked of the payer (276/277, 0120): the claim and the answer's state. */
  | "claim_status_check"
  /** A prior authorization added, corrected or withdrawn on a chart (0124): the id, never its number. */
  | "prior_auth_change"
  /**
   * CMS's NCCI files loaded by the practice, or a load no longer used (0122):
   * PTP pairs or MUE values, how many rows were read and kept, the in-force
   * date. Never a row: they are CMS's, with AMA text.
   */
  | "ncci_load"
  /** Monthly figures entered or cleared (0125): how many, and for which months. */
  | "kpi_history_change";

export type AuditTargetType =
  | "patient"
  | "visit"
  | "superbill"
  | "denial"
  // An uploaded 835 (audit R10): the remittance_file row.
  | "remittance"
  | "rulebook"
  | "session"
  | "visit_type"
  | "visit_service"
  | "branding"
  // The practice's time zone and daily visit cap (Settings → Practice).
  | "practice"
  // The idle limit and who needs a second factor (Settings → Security, 0121).
  | "security"
  | "note_template"
  | "user"
  | "payer"
  // The org's roster of outside providers (audit R30).
  | "external_provider"
  // Intake (0111): a referral, and the practice's reason codes.
  | "referral"
  | "reason_code"
  // A document on a referral or a chart (0112).
  | "patient_document"
  // A task to the team (0116), which need not be about a patient.
  | "care_task"
  // Who the claims bill as, and the practice's own fees (0118).
  | "billing_provider"
  | "fee_schedule"
  // A batch of claims exported for the billing software (0118).
  | "claim_export"
  // A clearinghouse connection, an 837P file built, a response file read (0120).
  | "clearinghouse_connection"
  | "claim_submission"
  | "clearinghouse_file"
  // A load of CMS's NCCI files (0122).
  | "ncci_load"
  // A practice's monthly figures (0125).
  | "kpi_history";

export interface AuditEntry {
  orgId: string;
  userId: string | null;
  action: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string | null;
  /** Ids, field names, counts. Never PHI values. */
  payload?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Write one audit row inside a transaction that is already open. Throws if the
 * insert fails, which will roll the caller's work back with it — deliberate:
 * if we cannot say a chart was changed, we do not change it.
 */
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_log (
      org_id, user_id, action, target_type, target_id, payload, ip_address, user_agent
    ) VALUES (
      ${e.orgId}::uuid,
      ${e.userId ?? null}::uuid,
      ${e.action},
      ${e.targetType ?? null},
      ${e.targetId ?? null}::uuid,
      ${JSON.stringify(e.payload ?? {})}::jsonb,
      ${e.ipAddress ?? null}::inet,
      ${e.userAgent ?? null}
    )
  `;
}

/**
 * For callers with no transaction to join. Opens its own org context and
 * swallows failures, so a logging hiccup cannot 5xx the user — the trade the
 * login path already made deliberately.
 */
export async function recordAuditDetached(e: AuditEntry): Promise<void> {
  try {
    await withOrgContext(e.orgId, async (tx) => writeAudit(tx, e));
  } catch {
    /* best effort by design — see the note above */
  }
}

/**
 * The names of the fields a patch actually changes, for the payload. Values
 * are dropped on the floor; only the keys travel.
 */
export function changedFieldNames(patch: Record<string, unknown>): string[] {
  return Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort();
}
