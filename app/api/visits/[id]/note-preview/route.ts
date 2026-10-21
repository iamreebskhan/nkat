/**
 * GET /api/visits/[id]/note-preview — the note as a finished document.
 *
 * Mark, watching the free-text box he was shown [06:43]: "it'll give you some
 * structure to understand how it needs to look on the finished product."
 *
 * The renderer for that already existed, but only ever ran inside the PDF
 * packet — which requires a billing permission no clinician holds, and which
 * refuses unsigned visits. So the one person who wanted to see how their note
 * would read, at the one moment they could still change it, could not.
 *
 * Permissions: clinical read. This returns the caller's own view of a visit
 * they can already open, as HTML rather than as form fields. No document
 * leaves the system, so it is not an export and not a §164.528 disclosure.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getNotePreviewHtml } from "@/lib/features/visits/audit-packet.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

const CLINICAL_READ = ["visits.view.all", "visits.view.own", "visits.edit"];

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!CLINICAL_READ.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // Holding a permission from the list above is a way into the route; it is not
  // a claim on this particular visit. Without this, a clinician — .own only —
  // was refused another clinician's visit by /api/visits/[id] and handed the
  // same visit's whole note here.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  try {
    return ok(await getNotePreviewHtml({ orgId: session.orgId, visitId: id }));
  } catch (err) {
    return handleServiceError(err);
  }
}
