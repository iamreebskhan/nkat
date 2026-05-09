/**
 * /api/health/livez — liveness + DB reachability.
 *
 * 200 OK when the app is up + Postgres responds within 2s.
 * 503 when the DB ping fails or times out.
 *
 * Used by:
 *   - Nginx upstream health check
 *   - Playwright smoke
 *   - Status page
 *
 * No auth — designed for unauthenticated load balancer probing. Does
 * NOT leak schema details on failure (just "db_unreachable").
 */
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const DB_PING_TIMEOUT_MS = 2_000;

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db_ping_timeout")), DB_PING_TIMEOUT_MS),
      ),
    ]);
    return Response.json(
      { ok: true, db: "reachable", uptime_ms: Date.now() - startedAt },
      { status: 200 },
    );
  } catch (err) {
    return Response.json(
      {
        ok: false,
        db: "unreachable",
        reason: err instanceof Error && err.message === "db_ping_timeout" ? "timeout" : "error",
      },
      { status: 503 },
    );
  }
}
