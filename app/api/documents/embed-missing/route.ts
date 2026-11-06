/**
 * POST /api/documents/embed-missing — a platform admin adds search vectors to
 * the document sections stored without one, now rather than at the nightly
 * run (embed-backfill.service.ts). Platform admin only: it spends the
 * platform's OpenAI credit, on documents every practice searches.
 */
import { fail, handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { embedMissingChunks } from "@/lib/features/documents/embed-backfill.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(): Promise<Response> {
  const session = await requireAuth(["knowledge.view"]);
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") return fail("Platform admin only.", { status: 403 });
  try {
    return ok(await embedMissingChunks());
  } catch (err) {
    return handleServiceError(err);
  }
}
