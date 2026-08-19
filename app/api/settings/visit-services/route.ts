/**
 * The org's catalog of visit services.
 *
 *   GET  — list (add ?includeInactive=1 for the settings screen)
 *   POST — add a service
 *
 * Client walkthrough [02:32]: "agar koi visit type ho raha hai jo hum ne add
 * karna hai" — the org needs to extend the list itself.
 */
import { type NextRequest } from "next/server";

import { fail, ok, handleServiceError, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  CreateServiceSchema,
  createService,
  listServiceCatalog,
} from "@/lib/features/visits/visit-services.service";

/**
 * Reading the catalog is any-of: clinicians document with it, billing agents
 * read it off a superbill. requireAuth() is all-of, so the check is explicit.
 */
const READ_ANY = ["visits.edit", "visits.view.all", "visits.view.own", "settings.view"];

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "1";
  // Narrows to services scoped to this visit type (walkthrough 02:34).
  const visitType = req.nextUrl.searchParams.get("visitType") ?? undefined;
  try {
    const services = await listServiceCatalog({
      orgId: session.orgId,
      includeInactive,
      visitType,
    });
    return ok({ services });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, CreateServiceSchema);
  if (body instanceof Response) return body;

  try {
    const r = await createService({ orgId: session.orgId, payload: body, actorUserId: session.userId });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
