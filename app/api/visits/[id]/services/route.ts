/**
 * Services provided on a visit.
 *
 *   GET — what was recorded
 *   PUT — replace the set (whole-set, so unticking actually removes)
 *
 * Client walkthrough [02:36–02:47]: "koi visit types ke bhi against, agar
 * kuch different types [ki] services hongi ke is visit mein hum logon ne kya
 * kya un ko help provide karni [hai]."
 */
import { type NextRequest } from "next/server";

import { fail, ok, handleServiceError, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  SetVisitServicesSchema,
  listVisitServices,
  setVisitServices,
} from "@/lib/features/visits/visit-services.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

/** Any-of read: clinicians document it, billing agents read it off the bill. */
const READ_ANY = ["visits.edit", "visits.view.all", "visits.view.own"];

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // READ_ANY says who may use this route at all; whose visit this is, is the
  // separate question only visits.view.all answers "anyone's" — the same shape
  // as the note GET next door. visits.view.own and visits.edit both sit in the
  // clinician template (lib/features/team/team.types.ts), so without this line
  // the list of what was done for a colleague's patient — the advance care
  // planning discussion, the psychosocial support, the minutes and the
  // free-text note against each — came back to a clinician who is refused that
  // visit's record everywhere else. See visit-access.ts.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  try {
    const services = await listVisitServices({ orgId: session.orgId, visitId: id });
    return ok({ services });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // The same rule as the GET, and for more than a read's worth of reason: this
  // PUT replaces the whole set, so an empty `services` array on a colleague's
  // visit erases every service recorded on it — and one of them, advance care
  // planning, carries a CPT hint the bill is built from. visits.edit does not
  // narrow this to the caller's own visits (the clinician template holds it
  // next to visits.view.own, lib/features/team/team.types.ts) and
  // setVisitServices never asks whose visit it is. Before parseJson, so a
  // refused caller learns nothing about the body's validity either.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  const body = await parseJson(req, SetVisitServicesSchema);
  if (body instanceof Response) return body;

  try {
    const r = await setVisitServices({ orgId: session.orgId, visitId: id, payload: body });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
