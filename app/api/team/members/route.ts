/**
 * Team members — list org users with their permission set.
 * ?active=1 restricts to active org members (care-team pickers use this so
 * the roster matches what the patient service will accept).
 */
import { type NextRequest } from "next/server";

import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listMembers } from "@/lib/features/team/team.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["team.view"]);
  if (session instanceof Response) return session;
  const activeOnly = new URL(req.url).searchParams.get("active") === "1";
  const rows = await listMembers({ orgId: session.orgId, activeOnly });
  return ok({ rows, total: rows.length });
}
