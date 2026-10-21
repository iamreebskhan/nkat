/**
 * The structured visit note.
 *
 *   GET   — every section of the template version this visit's note is
 *           written under (its pin, else the org's active template; the pin
 *           is set by saving a section, carry-forward, recording vitals, and
 *           sign-off), with content and the list of required sections still
 *           empty
 *   PATCH — write one section
 *
 * Mark Hendrix, 20 Aug 2026 walkthrough [09:50]: "that visit note, which is
 * really, really critical from an audit standpoint, that it be in a kind of a
 * structured format."
 */
import { z } from "zod";
import { type NextRequest } from "next/server";

import { fail, ok, handleServiceError, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVisitNote, saveNoteSection } from "@/lib/features/visits/note.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

/** Same any-of read as the services route: billing reads the note off the bill. */
const READ_ANY = ["visits.edit", "visits.view.all", "visits.view.own"];

const SaveSectionSchema = z.object({
  sectionKey: z.string().trim().min(1).max(64),
  // TipTap JSON for prose, {items: string[]} for a list. Shape is validated
  // against the section's declared kind in the service, which is the only
  // place that knows which kind this key is.
  content: z.unknown(),
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

  // READ_ANY says who may use this route at all. Whose visit this is, is a
  // separate question, and only visits.view.all answers it "anyone's" —
  // see visit-access.ts.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  try {
    const note = await getVisitNote({ orgId: session.orgId, visitId: id });
    return ok(note);
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // The same ownership test as the GET, and for a stronger reason. visits.edit
  // is NOT an ownership gate: the clinician template carries it right next to
  // visits.view.own (lib/features/team/team.types.ts), so requireAuth above
  // admits exactly the caller this boundary exists to constrain. Without this
  // line a clinician refused the READ of a colleague's note could still write
  // paragraphs into it — saveNoteSection checks the visit's status, never its
  // clinician — and the colleague would sign them under their own name.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  const body = await parseJson(req, SaveSectionSchema);
  if (body instanceof Response) return body;

  try {
    const r = await saveNoteSection({
      orgId: session.orgId,
      visitId: id,
      sectionKey: body.sectionKey,
      content: body.content,
      userId: session.userId,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
