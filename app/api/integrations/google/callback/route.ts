/**
 * GET /api/integrations/google/callback?code=...&state=...
 *
 * Phase E callback. Verifies that `state` matches the calling session
 * (defense against cross-account hijack via a leaked auth link), then
 * exchanges the code for a refresh token and stores it encrypted.
 */
import { type NextRequest, NextResponse } from "next/server";

import { fail, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  exchangeCodeAndStore,
  GoogleConfigMissingError,
} from "@/lib/features/calendar/google-calendar.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(new URL(`/settings/integrations?google_error=${oauthError}`, req.url));
  }
  if (!code || !state) {
    return fail("Missing code or state.", { status: 400 });
  }
  if (state !== `${session.orgId}:${session.userId}`) {
    return fail("State mismatch — not your session.", { status: 401 });
  }

  try {
    await exchangeCodeAndStore({
      orgId: session.orgId,
      userId: session.userId,
      code,
    });
    return NextResponse.redirect(new URL("/settings/integrations?google_connected=1", req.url));
  } catch (err) {
    if (err instanceof GoogleConfigMissingError) {
      return fail(err.message, { status: 503 });
    }
    return handleServiceError(err);
  }
}
