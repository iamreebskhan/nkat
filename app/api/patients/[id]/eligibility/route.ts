/**
 * /api/patients/[id]/eligibility — ask the patient's payer, through the
 * clearinghouse, whether the patient is covered today (0120; 270/271).
 *
 *   GET   whether a connection can be asked (its name only)
 *   POST  ask; the answer is recorded with the chart's other coverage checks
 *
 * patients.edit, as recording a coverage check by hand takes.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { checkEligibility, eligibilityAvailability } from "@/lib/features/clearinghouse/realtime.service";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

interface Params {
  params: Promise<{ id: string }>;
}

const Body = z.object({ connectionId: z.string().uuid().optional().nullable() }).strict();

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await eligibilityAvailability({ orgId: session.orgId }));
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
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    return ok(
      await checkEligibility({ orgId: session.orgId, userId: session.userId, patientId: id, connectionId: body.connectionId ?? null }),
      { status: 201 },
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
