/**
 * Runs once when the server starts (Next.js instrumentation hook).
 *
 * Says in the server log when the app's database connection bypasses
 * row-level security (lib/db-role.ts), so a deployment pointed at the
 * superuser reports it on its first start rather than looking isolated. A
 * check only: it never stops the server starting.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { bypassSentence, bypassesRls, connectionRole } = await import("./lib/db-role");
    const role = await connectionRole();
    if (bypassesRls(role)) console.error(`[pallio] ${bypassSentence(role)}`);
  } catch {
    /* no database yet, or no pg_roles access: not a reason to refuse to start */
  }
}
