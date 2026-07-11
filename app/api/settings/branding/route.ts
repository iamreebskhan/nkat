/** Per-org white-label settings. */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  BrandingSchema,
  getBranding,
  updateBranding,
} from "@/lib/features/branding/branding.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.view"]);
  if (session instanceof Response) return session;
  const view = await getBranding(session.orgId);
  return ok(view);
}

export async function PUT(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, BrandingSchema);
  if (body instanceof Response) return body;
  try {
    const view = await updateBranding({ orgId: session.orgId, payload: body });
    return ok(view);
  } catch (err) {
    return handleServiceError(err);
  }
}
