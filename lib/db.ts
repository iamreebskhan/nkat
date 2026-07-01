/**
 * Prisma client + multi-tenant RLS support.
 *
 * Two clients exist:
 *   - `prisma`        connects as the `app` role (NOBYPASSRLS). Every
 *                     tenant-scoped query MUST run inside
 *                     `withOrgContext(orgId, fn)` which sets the
 *                     `app.current_org_id` GUC inside a tx so RLS
 *                     policies filter by org.
 *   - `prismaAdmin`   connects as the `admin` role (SUPERUSER, bypasses
 *                     RLS). Only callable via `withBreakglass(fn, reason)`
 *                     which requires a non-empty reason for audit. Used
 *                     for pre-tenant lookups (login, signup) + Mark's
 *                     cross-tenant dashboard.
 *
 * If ADMIN_DATABASE_URL is unset, `prismaAdmin` falls back to
 * DATABASE_URL — preserves dev ergonomics. In prod the two URLs MUST
 * point to different roles for RLS isolation to actually be enforced.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __pallio_prisma__: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __pallio_prisma_admin__: PrismaClient | undefined;
}

/** Tenant-scoped client — connects as the `app` role (NOBYPASSRLS). */
export const prisma: PrismaClient =
  globalThis.__pallio_prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

/**
 * Admin/breakglass client — connects as the `admin` role (SUPERUSER,
 * bypasses RLS). NEVER use this directly; always go through
 * `withBreakglass()` so a reason is logged.
 *
 * Falls back to the main DATABASE_URL when ADMIN_DATABASE_URL isn't
 * set (dev convenience). In production the env MUST have both set
 * to different roles.
 */
export const prismaAdmin: PrismaClient =
  globalThis.__pallio_prisma_admin__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    datasources: {
      db: {
        url: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
      },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__pallio_prisma__ = prisma;
  globalThis.__pallio_prisma_admin__ = prismaAdmin;
}

/**
 * Run a callback inside a Postgres transaction with `app.current_org_id`
 * set to `orgId`. RLS policies on tenant tables filter by this GUC.
 * For the `app` role (NOBYPASSRLS), missing/wrong GUC → zero rows
 * returned, never another tenant's data.
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error("withOrgContext: orgId must be a UUID.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_org_id = '${orgId}'`);
    return fn(tx);
  });
}

/**
 * Run a callback with the admin (RLS-bypass) client. Required for:
 *   - Login pre-tenant lookups (we don't know orgId until we find it)
 *   - Signup org creation (org row doesn't exist yet)
 *   - Platform admin cross-tenant queries
 *
 * Every call must supply a `reason` ≥10 chars; it's recorded so we
 * can audit usage. Production hardening (Phase 11): emit an audit_log
 * row for each call + alert on high-volume usage.
 */
export async function withBreakglass<T>(
  fn: (client: PrismaClient) => Promise<T>,
  reason: string,
): Promise<T> {
  if (!reason || reason.length < 10) {
    throw new Error("withBreakglass requires a reason of at least 10 chars.");
  }
  // Route through the admin (RLS-bypass) client in production; fall back to
  // the app client in dev/staging without a separate admin URL. In
  // production this fallback MUST NOT be taken — a missing ADMIN_DATABASE_URL
  // means RLS isn't enforced.
  const target =
    process.env.NODE_ENV === "production" && process.env.ADMIN_DATABASE_URL
      ? prismaAdmin
      : prisma;

  // Breakglass audit trail (migration 0052). Skip the routine pre-tenant
  // login/signup lookups (high-frequency, not security-relevant); record
  // every genuine cross-tenant/admin bypass. Fire-and-forget so a logging
  // failure never blocks the operation.
  if (!/^(login|signup)/i.test(reason)) {
    void target
      .$executeRaw`INSERT INTO breakglass_log (reason, node_env) VALUES (${reason}, ${process.env.NODE_ENV ?? null})`
      .catch(() => {});
  }
  return fn(target);
}
