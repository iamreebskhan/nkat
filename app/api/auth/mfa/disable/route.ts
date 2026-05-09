/** POST /api/auth/mfa/disable — wipe the user's MFA enrollment. */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { disableMfa } from "@/lib/features/auth/mfa.service";

export async function POST(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  await disableMfa(session.userId);
  return ok({ disabled: true });
}
