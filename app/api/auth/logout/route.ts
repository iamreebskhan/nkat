/**
 * POST /api/auth/logout
 *
 * Clears the session cookie. Always 200 — idempotent.
 */
import { clearSession } from "@/lib/auth";
import { ok } from "@/lib/api";

export async function POST(): Promise<Response> {
  await clearSession();
  return ok({ ok: true });
}
