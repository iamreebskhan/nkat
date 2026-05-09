/** GET /api/onboarding — fetch the org's onboarding status (creates row if absent). */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getOrCreateOnboarding } from "@/lib/features/onboarding/onboarding.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const status = await getOrCreateOnboarding(session.orgId);
  return ok(status);
}
