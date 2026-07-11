/**
 * Superbill for a visit:
 *   GET  — return the existing superbill (or a fresh draft).
 *   POST — build + persist the draft (idempotent on visit_id).
 */
import { type NextRequest } from "next/server";

import { ok, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  buildDraftFromVisit,
  getSuperbillByVisit,
  persistDraft,
} from "@/lib/features/superbills/superbill.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const existing = await getSuperbillByVisit({
    orgId: session.orgId,
    visitId: id,
  });
  if (existing) {
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: existing.patientId,
      accessType: "view",
      context: "superbill",
      request: req,
    });
    return ok({ existing, draft: null });
  }

  // No row yet — return a fresh in-memory draft so the FE can render it
  // without a separate POST round-trip.
  try {
    const draft = await buildDraftFromVisit({
      orgId: session.orgId,
      visitId: id,
    });
    return ok({ existing: null, draft });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.create"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const draft = await buildDraftFromVisit({
      orgId: session.orgId,
      visitId: id,
    });
    const r = await persistDraft({ orgId: session.orgId, draft });
    return ok({ id: r.id, draft }, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
