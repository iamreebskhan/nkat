/**
 * A patient's coverage checks (Level-1 doc:23, 0111).
 *
 *   GET  — the checks, newest first, including those made while the patient
 *          was still a referral
 *   POST — record a check
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  addInsuranceVerification,
  listPatientVerifications,
} from "@/lib/features/referrals/referral.service";
import { VerificationSchema } from "@/lib/features/referrals/referral.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok({ verifications: await listPatientVerifications({ orgId: session.orgId, patientId: id }) });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, VerificationSchema);
  if (body instanceof Response) return body;
  try {
    const r = await addInsuranceVerification({
      orgId: session.orgId,
      userId: session.userId,
      subject: { patientId: id },
      payload: body,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
