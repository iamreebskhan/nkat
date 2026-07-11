/**
 * GET    /api/integrations/google — status for the calling user
 * DELETE /api/integrations/google — disconnect
 */
import { type NextRequest } from "next/server";

import { ok, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { disconnect, getStatus } from "@/lib/features/calendar/google-calendar.service";

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  try {
    return ok(await getStatus({ orgId: session.orgId, userId: session.userId }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function DELETE(_req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  try {
    await disconnect({ orgId: session.orgId, userId: session.userId });
    return ok({ disconnected: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
