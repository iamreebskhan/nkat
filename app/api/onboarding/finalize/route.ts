import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

import { markRulebookComplete } from "@/lib/features/onboarding/onboarding.service";

export async function POST(): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const r = await markRulebookComplete(session.orgId);
  return ok(r);
}
