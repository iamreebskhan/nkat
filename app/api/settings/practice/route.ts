/** The practice's time zone and daily visit cap. See practice-settings.service.ts. */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getPracticeSettings,
  PracticeSettingsSchema,
  updatePracticeSettings,
} from "@/lib/features/org/practice-settings.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await getPracticeSettings(session.orgId));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, PracticeSettingsSchema);
  if (body instanceof Response) return body;
  try {
    const view = await updatePracticeSettings({
      orgId: session.orgId,
      payload: body,
      actorUserId: session.userId,
    });
    return ok(view);
  } catch (err) {
    return handleServiceError(err);
  }
}
