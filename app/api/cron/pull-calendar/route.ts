/**
 * POST /api/cron/pull-calendar — Phase E inbound sync.
 *
 * Pulls Google events for every connected clinician into the external
 * busy-block cache so the schedule grid shows non-Pallio commitments.
 * CRON_SECRET-protected (same pattern as the other cron routes).
 */
import { type NextRequest } from "next/server";

import { ok, fail, handleServiceError } from "@/lib/api";
import { pullAllConnected } from "@/lib/features/calendar/google-calendar.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return fail("CRON_SECRET not configured.", { status: 503 });
  if (req.headers.get("x-cron-secret") !== secret) {
    return fail("Unauthorized.", { status: 401 });
  }
  try {
    return ok(await pullAllConnected());
  } catch (err) {
    return handleServiceError(err);
  }
}
