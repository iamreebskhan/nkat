/**
 * Vitals for a visit.
 *
 *   PUT — record or correct this visit's readings (one row per visit)
 *
 * The longitudinal read lives on the patient, not here:
 * GET /api/patients/[id]/vitals. Mark Hendrix, 20 Aug 2026 [06:29]: "you're
 * going to collect their vitals, keep track of their vitals, their weight, all
 * of those things." The "keep track" half is the trend, which is why this is a
 * table and not a field in the note.
 */
import { z } from "zod";
import { type NextRequest } from "next/server";

import { ok, handleServiceError, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { saveVitals } from "@/lib/features/visits/note.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Every field is optional and nullable. A palliative home visit routinely
 * records some readings and not others; forcing a clinician to invent a number
 * is worse than an absent one. Ranges mirror the CHECK constraints in 0088 so
 * the caller gets a field-level message instead of a database error.
 */
const n = (min: number, max: number) =>
  z.number().min(min).max(max).nullable().optional();

const VitalsSchema = z.object({
  heightCm: n(20, 280),
  weightKg: n(0.5, 500),
  bpSystolic: n(40, 300),
  bpDiastolic: n(20, 200),
  heartRate: n(20, 250),
  respRate: n(4, 80),
  temperatureC: n(25, 45),
  spo2Percent: n(30, 100),
  // Palliative Performance Scale is defined only in steps of 10.
  ppsPercent: z
    .number()
    .min(0)
    .max(100)
    .refine((v) => v % 10 === 0, "PPS is recorded in steps of 10.")
    .nullable()
    .optional(),
  painScore: n(0, 10),
  notes: z.string().max(2000).nullable().optional(),
});

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // visits.edit admits the .own-only clinician — the clinician template holds
  // it alongside visits.view.own (lib/features/team/team.types.ts) — and
  // saveVitals asks only for the visit's status, never for its clinician. These
  // are the readings the patient's weight curve is drawn from, and saving them
  // also pins the visit's note template version, so without this line a
  // clinician refused the READ of a colleague's visit could write a blood
  // pressure into it and change which template the colleague's note is written
  // under. See visit-access.ts. Before parseJson, so a refused caller learns
  // nothing about the body's validity either.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  const body = await parseJson(req, VitalsSchema);
  if (body instanceof Response) return body;

  try {
    const r = await saveVitals({
      orgId: session.orgId,
      visitId: id,
      vitals: body,
      userId: session.userId,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
