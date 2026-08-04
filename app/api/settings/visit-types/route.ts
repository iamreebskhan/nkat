/**
 * The org's visit types.
 *
 *   GET  — list (add ?includeInactive=1 for the settings screen)
 *   POST — add one
 *
 * Client walkthrough [02:30]: "agar koi visit type ho raha hai jo hum ne add
 * karna hai."
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  CreateVisitTypeSchema,
  createVisitType,
  listVisitTypes,
} from "@/lib/features/visits/visit-types.service";

/** Anyone who schedules or documents needs to read the list. */
const READ_ANY = [
  "schedule.view",
  "schedule.create",
  "visits.edit",
  "visits.view.all",
  "visits.view.own",
  "settings.view",
];

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "1";
  try {
    const types = await listVisitTypes({ orgId: session.orgId, includeInactive });
    return ok({ types });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, CreateVisitTypeSchema);
  if (body instanceof Response) return body;

  try {
    const r = await createVisitType({ orgId: session.orgId, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
