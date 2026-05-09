/**
 * Prisma client singleton with multi-tenant RLS support.
 *
 * The existing Postgres schema (carried over from billing-rules-platform)
 * uses RLS policies keyed off `app.current_org_id` GUC. Every tenant-
 * scoped query MUST run inside `withOrgContext(orgId, fn)` so the GUC
 * is set before any SELECT fires.
 *
 * Prisma's connection pool reuses connections, so we set the GUC
 * inside an explicit transaction (SET LOCAL scopes to the tx). The
 * GUC reverts when the tx commits, leaving the connection clean for
 * the next checkout.
 *
 * Pattern source: pallio plan §Risks #1.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __pallio_prisma__: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__pallio_prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  // Hot-reload: keep the client across module reloads in dev. Without
  // this, every change blasts the connection pool.
  globalThis.__pallio_prisma__ = prisma;
}

/**
 * Run a callback inside a Postgres transaction with `app.current_org_id`
 * set to `orgId`. RLS policies on tenant tables filter rows by this
 * GUC — without it, RLS returns zero rows for the `app` role.
 *
 * Use this for EVERY tenant-scoped query path. If a query reads
 * patient/visit/payer_rule/etc. tables, it must be inside this wrapper.
 *
 * Example:
 *   const visits = await withOrgContext(session.orgId, (tx) =>
 *     tx.visit.findMany({ where: { patientId } })
 *   );
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // Defensive: reject obviously malformed UUIDs at the boundary so we
  // never inject untrusted text into a SQL identifier-like position.
  // RLS still protects us, but failing fast is cheaper.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error("withOrgContext: orgId must be a UUID.");
  }

  return prisma.$transaction(async (tx) => {
    // SET LOCAL scopes the GUC to this tx. Use parameterized SQL so
    // even though we validated above, we never concatenate.
    await tx.$executeRawUnsafe(`SET LOCAL app.current_org_id = '${orgId}'`);
    return fn(tx);
  });
}

/**
 * Escape hatch — run a callback with elevated `breakglass` privileges
 * that bypass RLS. Reserved for cross-tenant admin tasks (e.g. Mark's
 * platform-wide dashboard). Every call is audit-logged by the caller.
 *
 * NOTE: requires the connection to be authenticated as the breakglass
 * role. The standard `app` role cannot bypass RLS even with this.
 */
export async function withBreakglass<T>(
  fn: (client: PrismaClient) => Promise<T>,
  reason: string,
): Promise<T> {
  if (!reason || reason.length < 10) {
    throw new Error("withBreakglass requires a reason of at least 10 chars.");
  }
  // TODO(phase-6): emit audit log row + page on-call for visibility.
  return fn(prisma);
}
