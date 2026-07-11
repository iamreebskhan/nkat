/**
 * POST /api/integrations/google/busy
 *
 * Phase E. Called by the schedule form before submitting a new visit
 * to surface "you already have something on your Google calendar at
 * this time." Returns the busy ranges for the clinician's primary
 * calendar between [from, to].
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getBusyForClinician,
  GoogleConfigMissingError,
} from "@/lib/features/calendar/google-calendar.service";

const Body = z.object({
  /** Defaults to the calling user — operator can request another user's busy with permission. */
  userId: z.string().uuid().optional(),
  fromIso: z.string().datetime(),
  toIso: z.string().datetime(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  const userId = body.userId ?? session.userId;
  try {
    const busy = await getBusyForClinician({
      orgId: session.orgId,
      userId,
      fromIso: body.fromIso,
      toIso: body.toIso,
    });
    return ok({ busy });
  } catch (err) {
    if (err instanceof GoogleConfigMissingError) {
      return fail(err.message, { status: 503 });
    }
    return handleServiceError(err);
  }
}
