/** GET /api/admin/compliance — live HIPAA / RLS / retention probe. */
import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { runComplianceChecks } from "@/lib/features/admin/compliance.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin access required.", { status: 403 });
  }
  const checks = await runComplianceChecks();
  return ok({ checks, runAt: new Date().toISOString() });
}
