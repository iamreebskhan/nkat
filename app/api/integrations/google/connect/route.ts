/**
 * GET /api/integrations/google/connect
 *
 * Phase E. Builds the Google OAuth consent URL and redirects the
 * user there. We embed `${orgId}:${userId}` in the `state` param
 * (the callback verifies it against the cookie session).
 */
import { NextResponse, type NextRequest } from "next/server";

import { fail, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  buildAuthUrl,
  GoogleConfigMissingError,
} from "@/lib/features/calendar/google-calendar.service";

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  try {
    const state = `${session.orgId}:${session.userId}`;
    return NextResponse.redirect(buildAuthUrl(state));
  } catch (err) {
    if (err instanceof GoogleConfigMissingError) {
      return fail(err.message, { status: 503 });
    }
    return handleServiceError(err);
  }
}
