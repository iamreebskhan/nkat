import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

import { isMfaEnrolled } from "@/lib/features/auth/mfa.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth([], { allowPendingMfa: true });
  if (session instanceof Response) return session;
  return ok({
    enrolled: await isMfaEnrolled(session.userId),
    // 0121: whether this person's role (or the org) requires one, and whether
    // this session still owes it.
    required: session.mfaReq === true,
    pending: session.mfaReq === true && session.mfa !== true,
  });
}
