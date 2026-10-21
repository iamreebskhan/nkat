/**
 * POST /api/superbills/predict
 *
 * Phase B — preview-only denial-risk predictor. Accepts a draft
 * payload (no DB write) and returns the structured risk result the
 * nurse-facing UI shows as inline badges + summary modal.
 *
 * Body:
 *   payerId?      UUID
 *   state?        CHAR(2)
 *   patientId?    UUID  (used for frequency-limit history)
 *   dos           YYYY-MM-DD
 *   cptCodes      string[]
 *   modifiers?    string[]
 *   icd10Codes?   string[]
 *   patientPriorAuth?  boolean
 *   clinicianTaxonomy? string
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { predictSuperbill } from "@/lib/features/billing/predict-superbill.service";
import { isCalendarDay } from "@/lib/features/org/org-date";

const Schema = z.object({
  payerId: z.string().uuid().nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  patientId: z.string().uuid().optional(),
  // A day that exists: the documentation check binds it into ::date, and
  // Postgres refuses 2026-09-31 (a 500 had it got that far).
  dos: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDay, "Not a calendar day."),
  cptCodes: z.array(z.string().min(1).max(10)).max(50),
  modifiers: z.array(z.string().min(1).max(4)).max(20).optional(),
  icd10Codes: z.array(z.string().min(1).max(10)).max(50).optional(),
  patientPriorAuth: z.boolean().optional(),
  clinicianTaxonomy: z.string().min(1).max(40).optional(),
  /**
   * The saved bill under review, when there is one. Its own lines are not
   * prior history for the frequency check, and its note is checked against
   * the payer's documentation standard (audit R19).
   */
  superbillId: z.string().uuid().optional(),
  /** The visit being billed, before its bill is saved (audit R19). */
  visitId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["superbill.predict"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  try {
    const result = await predictSuperbill({
      orgId: session.orgId,
      payerId: body.payerId ?? null,
      state: body.state ?? null,
      patientId: body.patientId,
      dos: body.dos,
      cptCodes: body.cptCodes,
      modifiers: body.modifiers,
      icd10Codes: body.icd10Codes,
      patientPriorAuth: body.patientPriorAuth,
      clinicianTaxonomy: body.clinicianTaxonomy,
      excludeSuperbillId: body.superbillId,
      visitId: body.visitId,
    });
    return ok(result);
  } catch (err) {
    return handleServiceError(err);
  }
}
