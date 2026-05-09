/**
 * GET /api/auth/me
 *
 * Returns the current session payload (excluding the JWT itself).
 * 401 if not authenticated. Used by the frontend to bootstrap the
 * authenticated shell and render the role-correct sidebar manifest.
 */
import { fail, ok } from "@/lib/api";
import { getSession } from "@/lib/auth";

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return fail("Not authenticated.", { status: 401 });

  return ok({
    userId: session.userId,
    orgId: session.orgId,
    email: session.email,
    role: session.role,
    permissions: session.permissions,
  });
}
