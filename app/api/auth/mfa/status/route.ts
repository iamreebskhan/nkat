import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

import { isMfaEnrolled } from "@/lib/features/auth/mfa.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  return ok({ enrolled: await isMfaEnrolled(session.userId) });
}
