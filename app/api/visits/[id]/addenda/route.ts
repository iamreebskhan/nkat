/**
 * /api/visits/[id]/addenda — corrections to a signed note (audit R15).
 *
 * GET: clinical read, the same any-of rule as the note preview.
 * POST: visits.submit. An addendum is an attestation, so it takes the
 * permission that signs a visit — clinicians and org admins hold it, billing
 * agents do not. The author's name and credential are printed on it.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  ADDENDUM_MAX,
  addVisitAddendum,
  listVisitAddenda,
} from "@/lib/features/visits/addendum.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

const CLINICAL_READ = ["visits.view.all", "visits.view.own", "visits.edit"];

const Body = z.object({ body: z.string().trim().min(1).max(ADDENDUM_MAX) });

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!CLINICAL_READ.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  // An addendum quotes the note it corrects, so the same ownership rule that
  // guards the note guards the list of them (visit-access.ts).
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;
  try {
    return ok({ addenda: await listVisitAddenda({ orgId: session.orgId, visitId: id }) });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.submit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  // visits.submit is not an ownership gate either — the clinician template
  // holds it (lib/features/team/team.types.ts), which is how a clinician signs
  // their own visit. So the same caller the GET refuses could otherwise post an
  // attestation onto a colleague's signed note, printed with the poster's name
  // and credential, correcting text they are not allowed to read.
  // addendum.service.ts does not test ownership; this is the only place it is.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    const addendum = await addVisitAddendum({
      orgId: session.orgId,
      visitId: id,
      userId: session.userId,
      body: body.body,
    });
    return ok({ addendum }, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
