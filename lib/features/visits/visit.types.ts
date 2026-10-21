/**
 * Visit types + Zod schemas.
 *
 * Schema mirrors db/migrations/0029_phase_pallio_emr.sql visit table.
 */
import { z } from "zod";

/**
 * The CPT coding bands. NOT the list a user picks from — since 0062 an
 * org defines its own visit types (org_visit_type), and each declares which of
 * these bands it bills as. Keep this closed: cpt-suggester branches on it, so
 * adding a member here changes what gets billed.
 *
 * Telehealth is not a band (audit R22, 0099). It is how the encounter
 * happened — visit.is_telehealth, which adds modifier 95/93 and POS 10 — and
 * as a band of its own it put every new patient seen over video on the
 * established ladder.
 *
 * `non_billable` codes nothing on purpose (audit R18, 0100). A bereavement
 * follow-up or a caregiver-only visit is documented and signed, and never
 * billed. Before it existed such a visit could only be entered as an alias of
 * a billable band, so it coded an E/M at sign-off.
 */
export const VISIT_TYPES = [
  "new_patient_home",
  "established_patient_home",
  "advance_care_planning",
  "inpatient_consult",
  "non_billable",
] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

/**
 * The bands a visit type can be created with or moved to (audit R18).
 * inpatient_consult is left out until an inpatient ladder exists: the suggester
 * codes nothing for it, so a visit on it could never be signed. Rows that
 * already carry it keep it, which is why it stays in VISIT_TYPES and the CHECK.
 */
export const SELECTABLE_CODING_BASES = [
  "new_patient_home",
  "established_patient_home",
  "advance_care_planning",
  "non_billable",
] as const satisfies readonly VisitType[];

export const VISIT_STATUSES = [
  "scheduled",
  "in_progress",
  "documented",
  "pending_billing",
  "billed",
  "cancelled",
  "no_show",
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const TELEHEALTH_MODALITIES = ["audio_video", "audio_only"] as const;
export type TelehealthModality = (typeof TELEHEALTH_MODALITIES)[number];

const Iso = z.string().datetime({ offset: true });
const IsoLoose = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

export const ScheduleVisitSchema = z.object({
  patientId: z.string().uuid(),
  clinicianUserId: z.string().uuid(),
  // An org-defined slug, validated against org_visit_type at schedule time —
  // a closed enum here would reject the org's own custom types.
  visitType: z.string().trim().min(2).max(64),
  scheduledStart: Iso.or(IsoLoose),
  scheduledEnd: Iso.or(IsoLoose).optional(),
  isTelehealth: z.boolean(),
  telehealthModality: z.enum(TELEHEALTH_MODALITIES).optional(),
  /**
   * Phase E — set true to bypass the Google-calendar conflict warning.
   * When false (default), the server checks the clinician's Google
   * calendar and refuses with a 409 + list of conflicting events if
   * any overlap is found.
   */
  confirmDoubleBook: z.boolean().optional(),
});
export type ScheduleVisit = z.infer<typeof ScheduleVisitSchema>;

/**
 * How far back an earlier visit makes a patient established: a new patient has
 * not received a professional service from this physician or NPP, or another of
 * the same specialty in the same group, within the past three years (CMS
 * 100-04 ch.12 §30.6.7(A); CPT E/M guidelines).
 */
export const NEW_PATIENT_LOOKBACK_YEARS = 3;

/**
 * Correct a visit's type before it is signed (PATCH /api/visits/[id]/visit-type).
 * An org slug, like ScheduleVisitSchema's, checked against the org's own active
 * types by changeVisitType.
 */
export const ChangeVisitTypeSchema = z.object({
  visitType: z.string().trim().min(2).max(64),
});
export type ChangeVisitType = z.infer<typeof ChangeVisitTypeSchema>;

/**
 * What Pallio's own history says about new vs established for one patient on
 * one date (GET /api/patients/[id]/visit-type-hint). A hint, never a decision:
 * Pallio cannot see visits the practice held before it used Pallio.
 */
export interface VisitTypeHint {
  /** The latest earlier visit in the window (start, else scheduled start); null when none. */
  lastVisitAt: string | null;
  lastVisitStatus: VisitStatus | null;
  /** NEW_PATIENT_LOOKBACK_YEARS before the date asked about. */
  windowStart: string;
  suggestedBasis: "new_patient_home" | "established_patient_home";
}

/** Used while documenting — the clinician's draft state. */
export const DocumentVisitSchema = z
  .object({
    startTime: Iso.or(IsoLoose).optional(),
    stopTime: Iso.or(IsoLoose).optional(),
    totalMinutes: z.number().int().min(0).max(720).optional(),
    acpMinutes: z.number().int().min(0).max(180).optional(),
    prolongedMinutes: z.number().int().min(0).max(180).optional(),
    documentText: z.string().max(50_000).optional(),
    cptCodesAssigned: z.array(z.string()).max(20).optional(),
    /**
     * Units per code in cptCodesAssigned when more than one, e.g. {"G0318": 3}
     * (0106). Only ever sent with the codes it counts: the visit's units are
     * written beside its codes and never on their own.
     */
    cptUnits: z.record(z.string().min(1).max(10), z.number().int().min(1).max(99)).optional(),
    icd10Codes: z.array(z.string()).max(20).optional(),
    modifiers: z.array(z.string()).max(10).optional(),
    isTelehealth: z.boolean().optional(),
    telehealthModality: z.enum(TELEHEALTH_MODALITIES).optional(),
    telehealthConsentDocumented: z.boolean().optional(),
    /** Where the visit took place (audit R23): a CMS place-of-service code. */
    placeOfServiceCode: z
      .string()
      .regex(/^\d{2}$/, "Use the 2-digit CMS place-of-service code")
      .optional(),
    /**
     * The visit type (org slug) the sender worked its codes out for. A screen
     * opened before the type was changed elsewhere still codes on the old band;
     * documentVisit refuses its save when the visit's type is no longer this
     * one, so the old ladder's codes are not written back — or signed, since
     * signing saves first. Optional: a caller that does not send it is not checked.
     */
    visitType: z.string().trim().min(2).max(64).optional(),
  })
  .refine((p) => !p.cptUnits || p.cptCodesAssigned !== undefined, {
    path: ["cptUnits"],
    message: "Send units together with the codes they count (cptCodesAssigned).",
  });
export type DocumentVisit = z.infer<typeof DocumentVisitSchema>;

/** Visit row as the API returns it. */
export interface VisitView {
  id: string;
  patientId: string;
  clinicianUserId: string;
  /** The org's own slug (org_visit_type.slug), not necessarily a VisitType. */
  visitType: string;
  /** Human label for that slug — what the UI shows. */
  visitTypeLabel: string;
  /**
   * The CPT band the slug bills as. Feed THIS to the code suggester, never the
   * raw slug, or a custom type would fall through the coder's switch.
   */
  codingBasis: VisitType;
  /**
   * The visit type forces telehealth (org_visit_type.is_telehealth, audit
   * R22): the visit's own box cannot be unticked, only the type changed.
   */
  visitTypeIsTelehealth: boolean;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startTime: string | null;
  stopTime: string | null;
  /**
   * The visit's day where the practice is ('YYYY-MM-DD', 0107): its start,
   * else its scheduled start. The day to show beside a visit; slicing either
   * instant gives its UTC day, which after 8 pm in Ohio is tomorrow. Null when
   * neither is set.
   */
  serviceDay: string | null;
  totalMinutes: number | null;
  acpMinutes: number;
  prolongedMinutes: number;
  isTelehealth: boolean;
  telehealthModality: TelehealthModality | null;
  telehealthConsentDocumented: boolean;
  /** Where the visit took place (audit R23); null on visits before 0095. */
  placeOfServiceCode: string | null;
  /** Who signed it, and the credential they attested under (audit R32). */
  signedByUserId: string | null;
  signerName: string | null;
  signerCredential: string | null;
  documentText: string | null;
  cptCodesAssigned: string[];
  /** Units per code when more than one, e.g. {"G0318": 3}; {} = one each (0106). */
  cptUnits: Record<string, number>;
  icd10Codes: string[];
  modifiers: string[];
  status: VisitStatus;
  signedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Joined display fields (list view only; null on single-visit reads). */
  patientName?: string | null;
  patientCity?: string | null;
  clinicianName?: string | null;
}
