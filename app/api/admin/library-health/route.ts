/**
 * GET /api/admin/library-health — rule-library health and coverage.
 *
 * The single place that answers "is the rule library actually working,
 * and what does it not know?". Both halves matter: the library ran with
 * three sources and rules for three of nineteen payers for months
 * because a lookup returning "Unknown" looks the same whether the payer
 * has no such rule or the library is simply empty.
 *
 * Platform-admin only — this is operator data about the shared library,
 * not tenant data.
 */
import { ok, fail } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getCoverageMatrix,
  getLibrarySummary,
  getSourceHealth,
  getWeakCitations,
} from "@/lib/features/ingestion/library-health.service";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // Same gate as the other /api/admin routes.
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }

  try {
    const [summary, sources, coverage, weakCitations] = await Promise.all([
      getLibrarySummary(),
      getSourceHealth(),
      getCoverageMatrix(),
      getWeakCitations(),
    ]);
    return ok({ summary, sources, coverage, weakCitations });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library health check failed.";
    return fail(message, { status: 500 });
  }
}
