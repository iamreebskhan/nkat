import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { setupMfa } from "@/lib/features/auth/mfa.service";

export async function POST(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const r = await setupMfa({ userId: session.userId, email: session.email });
  return ok(r);
}
