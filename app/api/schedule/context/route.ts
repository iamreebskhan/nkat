/**
 * GET /api/schedule/context?from&to — schedule overlays for the week grid:
 * external Google busy blocks + PTO. Visits come from /api/visits.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getExternalBusyBlocks } from "@/lib/features/calendar/google-calendar.service";
import { listTimeOff } from "@/lib/features/schedule/time-off.service";

const Query = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["schedule.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;

  let externalBusy: Awaited<ReturnType<typeof getExternalBusyBlocks>> = [];
  try {
    externalBusy = await getExternalBusyBlocks({
      orgId: session.orgId,
      fromIso: params.from,
      toIso: params.to,
    });
  } catch {
    /* calendar not configured */
  }
  const timeOff = await listTimeOff({ orgId: session.orgId, fromIso: params.from, toIso: params.to });
  return ok({ externalBusy, timeOff });
}
