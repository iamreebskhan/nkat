/**
 * POST /api/auth/logout
 *
 * Clears the session cookie. Always 200 — idempotent.
 */
import { ok } from "@/lib/api";
import { clearSession } from "@/lib/auth";

export async function POST(): Promise<Response> {
  await clearSession();
  return ok({ ok: true });
}
