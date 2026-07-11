/** GET /api/inbox — current user's task feed. */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listInbox } from "@/lib/features/inbox/inbox.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const items = await listInbox({
    orgId: session.orgId,
    userId: session.userId,
    canSeeDenials: session.permissions.includes("billing.denials.view"),
    canAttest: session.permissions.includes("knowledge.attest"),
  });
  return ok({ rows: items, total: items.length });
}
