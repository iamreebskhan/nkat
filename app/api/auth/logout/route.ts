/**
 * POST /api/auth/logout { reason?: "idle" }
 *
 * Clears the session cookie. Always 200 — idempotent. The sign-out goes on the
 * audit trail (0121) with its reason, even when the session has already passed
 * its idle limit: who it belonged to is still read from the token.
 */
import { type NextRequest } from "next/server";

import { ok } from "@/lib/api";
import { clearSession, readSessionIdentity } from "@/lib/auth";
import { recordAuditDetached } from "@/lib/features/audit/audit-write";

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = body?.reason === "idle" ? "idle" : "manual";
  const who = await readSessionIdentity();
  await clearSession();
  if (who) {
    await recordAuditDetached({ orgId: who.orgId, userId: who.userId, action: "logout", payload: { reason } });
  }
  return ok({ ok: true });
}
