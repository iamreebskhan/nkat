/** POST /api/auth/mfa/disable — wipe the user's MFA enrollment. */
import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { recordAuditDetached } from "@/lib/features/audit/audit-write";
import { disableMfa } from "@/lib/features/auth/mfa.service";
import { mfaRequiredFor, readSessionPolicy } from "@/lib/features/auth/session-policy";

export async function POST(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  // Refused while the role (or the org's policy) requires it (0121), read now
  // rather than from the session, so a policy changed since still counts.
  const policy = await readSessionPolicy(session.orgId);
  if (mfaRequiredFor(session.role, session.permissions, policy.mfaPolicy)) {
    return fail(
      "Your role signs in with a second factor, so it can't be turned off. To move it to a new phone, set it up again: the current one keeps working until the new one is confirmed.",
      { status: 422 },
    );
  }
  await disableMfa(session.userId);
  void recordAuditDetached({
    orgId: session.orgId, userId: session.userId, action: "mfa_change",
    targetType: "user", targetId: session.userId, payload: { change: "disabled" },
  });
  return ok({ disabled: true });
}
