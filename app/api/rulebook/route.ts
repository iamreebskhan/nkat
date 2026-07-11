/** GET /api/rulebook — fetch the org's current rulebook + rows. */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

import { getRulebook } from "@/lib/features/rulebook/rulebook.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["knowledge.view"]);
  if (session instanceof Response) return session;
  const rb = await getRulebook({ orgId: session.orgId });
  return ok({ rulebook: rb });
}
