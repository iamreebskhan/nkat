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

  const body = await parseJson(req, SetVisitServicesSchema);
  if (body instanceof Response) return body;

  try {
    const r = await setVisitServices({ orgId: session.orgId, visitId: id, payload: body });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
