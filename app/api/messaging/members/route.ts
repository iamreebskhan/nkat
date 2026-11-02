/**
 * GET /api/messaging/members — who a team message can @mention: the org's
 * active members (Level-1 doc:57). For the composer's suggestions, so it
 * gates on messaging.send, not on team.view, which clinicians do not hold.
 */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listMentionable } from "@/lib/features/messaging/messaging.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["messaging.send"]);
  if (session instanceof Response) return session;
  const rows = await listMentionable(session.orgId);
  return ok({ rows });
}
