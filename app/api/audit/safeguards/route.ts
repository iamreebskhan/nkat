/**
 * GET /api/audit/safeguards: the data-protection checks an org admin sees on
 * the audit page (audit R24).
 *
 * Gated like the audit log itself (audit.view). Runs the org-scoped subset of
 * the platform compliance probes in client-safe wording: no table names, no
 * environment-variable names, no integration keys, and nothing read across
 * tenants. The full board stays at /admin/compliance for the platform
 * operator.
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { runOrgSafeguardChecks } from "@/lib/features/admin/compliance.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["audit.view"]);
  if (session instanceof Response) return session;
  try {
    const checks = await runOrgSafeguardChecks(session.orgId);
    return ok({ checks, runAt: new Date().toISOString() });
  } catch (err) {
    return handleServiceError(err);
  }
}
