/**
 * Is the app's own database connection subject to row-level security?
 *
 * `prisma` must connect as the `app` role (NOBYPASSRLS): RLS is what keeps one
 * organization's rows from another's, and a superuser or a BYPASSRLS role
 * ignores every policy. On such a connection isolation rests on each query's
 * own org filter, which is how a deployment connecting as the superuser ended
 * up depending on them alone. Only the breakglass client may bypass
 * (lib/db.ts).
 *
 * Read by the safeguard checks (the audit page and the platform compliance
 * board) and once at server start (instrumentation.ts), so a misconfigured
 * deployment says so instead of looking isolated.
 */
import { prisma } from "@/lib/db";

export interface ConnectionRole {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
}

export async function connectionRole(): Promise<ConnectionRole> {
  const rows = await prisma.$queryRaw<{ role: string; superuser: boolean; bypass_rls: boolean }[]>`
    SELECT current_user::text AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls
      FROM pg_roles r
     WHERE r.rolname = current_user
  `;
  const r = rows[0];
  if (!r) throw new Error("The connection's role is not in pg_roles.");
  return { role: r.role, superuser: r.superuser, bypassRls: r.bypass_rls };
}

export function bypassesRls(r: ConnectionRole): boolean {
  return r.superuser || r.bypassRls;
}

/** What the platform board and the startup log say about a bypassing role. */
export function bypassSentence(r: ConnectionRole): string {
  return (
    `DATABASE_URL connects as "${r.role}", which ${r.superuser ? "is a superuser" : "has BYPASSRLS"}: ` +
    "row-level security does not apply to the app, so organizations are kept apart only by each " +
    "query's own org filter. Point DATABASE_URL at the app role (NOBYPASSRLS); only " +
    "ADMIN_DATABASE_URL, the breakglass client, should bypass."
  );
}
