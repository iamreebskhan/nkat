/**
 * Carry a note forward from the patient's last signed visit.
 *
 *   GET  — what is available to bring forward (source visit + its sections)
 *   POST — copy the chosen sections into this visit
 *
 * Mark Hendrix, 20 Aug 2026 [11:01]: "if you create a note for a new patient,
 * then you can use that note as a template for the next visit." Explicit and
 * per-section by design — see 0089 for why a silent copy would have been the
 * wrong build.
 */
import { z } from "zod";
import { type NextRequest } from "next/server";

import { fail, ok, handleServiceError, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  carryForwardSections,
  getCarryForwardSource,
} from "@/lib/features/visits/note.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

const READ_ANY = ["visits.edit", "visits.view.all", "visits.view.own"];

const CarrySchema = z.object({
  fromVisitId: z.string().uuid(),
  sectionKeys: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
});

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // The visit being written into — see visit-access.ts. The SOURCE visit is
  // deliberately not ownership-checked: carry-forward is patient-scoped by
  // design ("use that note as a template for the next visit"), and the
  // patient's last signed visit is routinely somebody else's — four open
  // visits on the local fixture are offered exactly that.
  //
  // So this call hands the caller that visit's id, date of service and type
  // label, plus the keys and labels of its non-empty sections — never the
  // text in them. The id is the part that matters: it is how another
  // clinician's visit reached GET /note-preview, and why the note, preview,
  // reconciliation, addenda and audit packet each run this same guard on the
  // id they are given instead of trusting it. See POST for the content.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  try {
    const source = await getCarryForwardSource({ orgId: session.orgId, visitId: id });
    return ok({ source });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // visits.edit is a door, not a claim on this visit: the clinician template
  // carries it next to visits.view.own (lib/features/team/team.types.ts), so
  // requireAuth above admits precisely the caller this boundary constrains.
  // carryForwardSections checks the target's status and never its clinician,
  // so without this line a clinician refused the READ of a colleague's visit
  // could still pour a previous note into it, section by section, and leave
  // carry-forward provenance behind saying the colleague did it.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  const body = await parseJson(req, CarrySchema);
  if (body instanceof Response) return body;

  try {
    // The source may still belong to another clinician — that is the feature,
    // not an oversight — but it is not the caller's to name. The service
    // accepts any signed visit of this patient, which is wider than the panel
    // driving it: sectioned-note.tsx sends back exactly the visitId the GET
    // above offered. Re-resolving it here costs one query and closes the gap
    // between what is offered and what will be copied.
    //
    // Why the source is not ownership-checked when everything else here is:
    // this caller already holds patients.view, and GET /api/patients/[id]/export
    // renders every signed visit's note for this patient into one PDF with no
    // clinician filter at all. Refusing the carry forward would delete a
    // designed feature without putting the text out of reach. The ownership
    // rule governs which visit you may open and write in; the chart-wide wall
    // is patients.view, and it is somewhere else.
    const source = await getCarryForwardSource({ orgId: session.orgId, visitId: id });
    if (!source || source.visitId !== body.fromVisitId) {
      return fail(
        "That visit is not the one currently offered to carry forward. Reload this visit and try again.",
        { status: 422 },
      );
    }

    const r = await carryForwardSections({
      orgId: session.orgId,
      visitId: id,
      fromVisitId: body.fromVisitId,
      sectionKeys: body.sectionKeys,
      userId: session.userId,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
