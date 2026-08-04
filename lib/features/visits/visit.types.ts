/**
 * Visit types + Zod schemas.
 *
 * Schema mirrors db/migrations/0029_phase_pallio_emr.sql visit table.
 */
import { z } from "zod";

export const VISIT_TYPES = [
  "new_patient_home",
  "established_patient_home",
  "advance_care_planning",
  "telehealth",
  "inpatient_consult",
] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

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
  visitType: z.enum(VISIT_TYPES),
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

/** Used while documenting — the clinician's draft state. */
export const DocumentVisitSchema = z.object({
  startTime: Iso.or(IsoLoose).optional(),
  stopTime: Iso.or(IsoLoose).optional(),
  totalMinutes: z.number().int().min(0).max(720).optional(),
  acpMinutes: z.number().int().min(0).max(180).optional(),
  prolongedMinutes: z.number().int().min(0).max(180).optional(),
  documentText: z.string().max(50_000).optional(),
  cptCodesAssigned: z.array(z.string()).max(20).optional(),
  icd10Codes: z.array(z.string()).max(20).optional(),
  modifiers: z.array(z.string()).max(10).optional(),
  isTelehealth: z.boolean().optional(),
  telehealthModality: z.enum(TELEHEALTH_MODALITIES).optional(),
  telehealthConsentDocumented: z.boolean().optional(),
});
export type DocumentVisit = z.infer<typeof DocumentVisitSchema>;

/** Visit row as the API returns it. */
export interface VisitView {
  id: string;
  patientId: string;
  clinicianUserId: string;
  visitType: VisitType;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startTime: string | null;
  stopTime: string | null;
  totalMinutes: number | null;
  acpMinutes: number;
  prolongedMinutes: number;
  isTelehealth: boolean;
  telehealthModality: TelehealthModality | null;
  telehealthConsentDocumented: boolean;
  documentText: string | null;
  cptCodesAssigned: string[];
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
