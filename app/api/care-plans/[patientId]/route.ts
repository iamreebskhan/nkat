/**
 * Care plan endpoint per patient.
 *   GET  — current care plan + version count.
 *   PUT  — upsert (creates first time, increments version after).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { NotFoundError, fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getCarePlan,
  upsertCarePlan,
} from "@/lib/features/care-plans/care-plan.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ patientId: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.view"]);
  if (session instanceof Response) return session;
  const { patientId } = await ctx.params;
  const cp = await getCarePlan({ orgId: session.orgId, patientId });
  void logPhiAccess({
    orgId: session.orgId,
    userId: session.userId,
    patientId,
    accessType: "view",
    context: "care_plan",
    request: req,
  });
  if (!cp) return ok({ carePlan: null });
  return ok({ carePlan: cp });
}

const PutSchema = z.object({
  document: z.unknown(),
  goalsOfCareSummary: z.string().max(5000).nullable().optional(),
  primarySymptoms: z.array(z.string().max(120)).max(40).optional(),
  activeMedications: z.array(z.string().max(200)).max(80).optional(),
  /** When set, also record a frozen version snapshot tied to this visit. */
  snapshotForVisitId: z.string().uuid().optional(),
});

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, PutSchema);
  if (body instanceof Response) return body;

  const { patientId } = await ctx.params;
  try {
    const r = await upsertCarePlan({
      orgId: session.orgId,
      patientId,
      document: body.document,
      goalsOfCareSummary: body.goalsOfCareSummary,
      primarySymptoms: body.primarySymptoms,
      activeMedications: body.activeMedications,
      snapshotForVisitId: body.snapshotForVisitId,
      signedByUserId: session.userId,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId,
      accessType: "edit",
      context: "care_plan",
      request: req,
    });
    return ok(r);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(err.message, { status: 404 });
    return fail(err instanceof Error ? err.message : "Save failed", {
      status: 422,
    });
  }
}
