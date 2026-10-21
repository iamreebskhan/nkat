/**
 * PUT /api/team/members/[userId]/profile — a clinician's NPI and credential.
 *
 * The NPI is what a claim names as rendering provider (audit R40); the
 * credential sets the rate it is priced at (audit R25). Requires
 * team.permissions: this changes who every future claim says treated the
 * patient.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { CLINICIAN_CREDENTIALS } from "@/lib/features/team/clinician";
import { saveClinicianProfile } from "@/lib/features/team/clinician-profile.service";

const Body = z.object({
  npi: z.string().trim().max(20).nullable(),
  credential: z.enum(CLINICIAN_CREDENTIALS).nullable(),
});

interface Params {
  params: Promise<{ userId: string }>;
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["team.permissions"]);
  if (session instanceof Response) return session;
  const { userId } = await ctx.params;
  const bad = requireUuidParam(userId);
  if (bad) return bad;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    return ok(
      await saveClinicianProfile({
        orgId: session.orgId,
        userId,
        actorUserId: session.userId,
        npi: body.npi,
        credential: body.credential,
      }),
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
