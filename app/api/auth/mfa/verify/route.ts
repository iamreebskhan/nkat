/** POST /api/auth/mfa/verify { code } — confirm enrollment. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson } from "@/lib/api";
import { requireAuth, setSessionCookie, signSession } from "@/lib/auth";
import { recordAuditDetached } from "@/lib/features/audit/audit-write";
import { confirmMfaSetup } from "@/lib/features/auth/mfa.service";

const Body = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth([], { allowPendingMfa: true });
  if (session instanceof Response) return session;

  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  const r = await confirmMfaSetup({ userId: session.userId, code: body.code });
  if ("error" in r) {
    if (r.error === "no_pending_setup") return fail("Run MFA setup first.", { status: 400 });
    return fail("Code didn't match. Try the next 30s window.", { status: 422 });
  }
  // The session now carries the second factor it owed, if it owed one (0121).
  await setSessionCookie(await signSession(session, { mfa: true }));
  void recordAuditDetached({
    orgId: session.orgId, userId: session.userId, action: "mfa_change",
    targetType: "user", targetId: session.userId, payload: { change: "enrolled", via: "settings" },
  });
  return ok(r);
}
