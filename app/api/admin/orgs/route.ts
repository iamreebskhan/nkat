/** Cross-tenant org list — platform_admin only. */
import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listAllOrgs } from "@/lib/features/admin/admin.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin access required.", { status: 403 });
  }
  const rows = await listAllOrgs(`platform_admin org list by ${session.userId}`);
  return ok({ rows, total: rows.length });
}
