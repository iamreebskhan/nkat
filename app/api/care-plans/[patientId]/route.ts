/**
 * Care plan endpoint per patient.
 *   GET  — current care plan + version count.
 *   PUT  — upsert (creates first time, increments version after).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getCarePlan,
  upsertCarePlan,
} from "@/lib/features/care-plans/care-plan.service";
import { CarePlanStructureSchema } from "@/lib/features/care-plans/care-plan.types";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ patientId: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.view"]);
  if (session instanceof Response) return session;
  const { patientId } = await ctx.params;
  const bad = requireUuidParam(patientId);
  if (bad) return bad;
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

// The structured parts (0116, doc:38): goals, interventions, monitoring, the
// escalation parameters and the review day; each absent part is kept.
const PutSchema = CarePlanStructureSchema.extend({
  document: z.unknown(),
  goalsOfCareSummary: z.string().max(5000).nullable().optional(),
  // Symptoms to monitor (doc:50), edited as a list on the care-plan screen.
  // A blank entry is not an entry. Medications are the chart's list (0114):
  // the plan reads them and no longer takes its own.
  primarySymptoms: z.array(z.string().trim().min(1).max(120)).max(40).optional(),
  /** The visit this edit is made during (doc:59); its sign-off freezes the plan. */
  visitId: z.string().uuid().optional(),
  /** When set, also record a frozen version snapshot tied to this visit. */
  snapshotForVisitId: z.string().uuid().optional(),
});

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, PutSchema);
  if (body instanceof Response) return body;

  const { patientId } = await ctx.params;
  const bad = requireUuidParam(patientId);
  if (bad) return bad;
  try {
    const r = await upsertCarePlan({
      orgId: session.orgId,
      patientId,
      document: body.document,
      goalsOfCareSummary: body.goalsOfCareSummary,
      primarySymptoms: body.primarySymptoms,
      structure: {
        goals: body.goals,
        interventions: body.interventions,
        monitoring: body.monitoring,
        escalation: body.escalation,
        reviewOn: body.reviewOn,
      },
      visitId: body.visitId,
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
    return handleServiceError(err);
  }
}
