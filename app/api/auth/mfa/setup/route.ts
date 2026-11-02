import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

import { setupMfa } from "@/lib/features/auth/mfa.service";

export async function POST(): Promise<Response> {
  // Open to a session that still owes its second factor (0121): this is how it pays.
  const session = await requireAuth([], { allowPendingMfa: true });
  if (session instanceof Response) return session;
  const r = await setupMfa({ userId: session.userId, email: session.email });
  return ok(r);
}
