/** The idle limit and who needs a second factor (0121). See security-settings.service.ts. */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getSecuritySettings,
  SecuritySettingsSchema,
  updateSecuritySettings,
} from "@/lib/features/org/security-settings.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await getSecuritySettings(session.orgId));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, SecuritySettingsSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updateSecuritySettings({ orgId: session.orgId, payload: body, actorUserId: session.userId }));
  } catch (err) {
    return handleServiceError(err);
  }
}
