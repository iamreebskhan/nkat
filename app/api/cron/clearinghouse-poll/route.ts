/**
 * POST /api/cron/clearinghouse-poll — check every active SFTP connection for
 * new responses (999, 277CA, 835 …) and apply them (0120). CRON_SECRET-
 * protected, as the other cron routes; run every 15 minutes or so.
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok } from "@/lib/api";
import { pollAllConnections } from "@/lib/features/clearinghouse/poll.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return fail("CRON_SECRET not configured.", { status: 503 });
  if (req.headers.get("x-cron-secret") !== secret) {
    return fail("Unauthorized.", { status: 401 });
  }
  try {
    return ok(await pollAllConnections());
  } catch (err) {
    return handleServiceError(err);
  }
}
