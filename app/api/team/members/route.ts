/** Team members — list active org users with their permission set. */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listMembers } from "@/lib/features/team/team.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["team.view"]);
  if (session instanceof Response) return session;
  const rows = await listMembers({ orgId: session.orgId });
  return ok({ rows, total: rows.length });
}
