/**
 * Superbill for a visit:
 *   GET  — return the existing superbill (or a fresh draft).
 *   POST — build + persist the draft: 201 with created: true. A visit that
 *          already has a bill gets it back as it stands, 200 with created:
 *          false and nothing written.
 */
import { type NextRequest } from "next/server";

import { ok, fail, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  buildDraftFromVisit,
  getSuperbillByVisit,
  persistDraft,
  type SuperbillView,
} from "@/lib/features/superbills/superbill.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
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

  // The billing permission is the door, not a claim on this visit — the same
  // rule every per-visit sibling takes (visit-access.ts). It was left off here
  // on the reasoning that every shipped template holding billing.superbills.*
  // also holds visits.view.all, which is a property of the TEMPLATES and not of
  // this route: permission sets are edited per member, and a member holding
  // exactly ["billing.superbills.view"] got 200 on any clinician's visit,
  // carrying the patient id, the subscriber's member id and the ICD-10 codes.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

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

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.create"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // Same guard as the GET, and checked before anything is built: persistDraft
  // writes a superbill row and an activity entry against this visit, so a
  // caller who may not read the visit must not be able to leave a trail on it
  // either.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  // The bill as it stands, read the way the GET serves it.
  const asItStands = (existing: SuperbillView) => {
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: existing.patientId,
      accessType: "view",
      context: "superbill",
      request: req,
    });
    return ok({ id: existing.id, created: false, existing, draft: null });
  };

  try {
    // A screen that loaded before the bill existed still posts here: the bill
    // page, Create Bill, a second tab. The visit's bill is then whatever was
    // saved since, and it is returned unchanged rather than rebuilt from the
    // visit over a biller's edits (see persistDraft).
    const existing = await getSuperbillByVisit({ orgId: session.orgId, visitId: id });
    if (existing) return asItStands(existing);

    const draft = await buildDraftFromVisit({
      orgId: session.orgId,
      visitId: id,
    });
    const r = await persistDraft({ orgId: session.orgId, draft, actorUserId: session.userId });
    if (r.created === false) {
      // Saved by someone else since the read above.
      const now = await getSuperbillByVisit({ orgId: session.orgId, visitId: id });
      if (now) return asItStands(now);
      return fail("This visit already has a bill. Reload the page to open it.", { status: 409 });
    }
    return ok({ id: r.id, created: true, draft }, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
