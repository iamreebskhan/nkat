/**
 * Platform layout — wraps all authenticated routes.
 *
 * Reads the session server-side. If unauth'd, redirect to /login. If
 * the role has a manifest, render the sidebar with role-specific
 * navigation; otherwise show a minimal shell (consultants with no
 * grants land here until the org admin invites them properly).
 */
import { redirect } from "next/navigation";

import { IdleGuard } from "@/components/auth/idle-guard";
import { MfaGate } from "@/components/auth/mfa-gate";
import { OfflineBanner } from "@/components/offline/offline-banner";
import { RegisterServiceWorker } from "@/components/offline/register-sw";
import { Sidebar } from "@/components/sidebar";
import { getSession } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { MANIFESTS, visibleNavItems } from "@/lib/manifests";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const manifest = MANIFESTS[session.role];
  const items = visibleNavItems(manifest, session.permissions);

  // Fetch org display name (branding override > org.name) for the
  // sidebar header. Best-effort — if it fails (RLS, DB blip), the
  // sidebar falls back to the static "Pallio" title.
  let orgName: string | undefined;
  try {
    orgName = await withOrgContext(session.orgId, async (tx) => {
      const rows = await tx.$queryRaw<{ name: string | null }[]>`
        SELECT COALESCE(b.display_name, o.name) AS name
        FROM org o
        LEFT JOIN org_branding b ON b.org_id = o.id
        WHERE o.id = ${session.orgId}::uuid
        LIMIT 1
      `;
      return rows[0]?.name ?? undefined;
    });
  } catch {
    orgName = undefined;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        items={items}
        userEmail={session.email}
        orgName={orgName}
      />
      {/* pt-14 under md clears the fixed mobile nav bar the sidebar renders. */}
      <main className="flex-1 min-w-0 bg-[var(--color-canvas)] pt-14 md:pt-0">
        {/* Offline (doc:33, 0119): the worker that opens the offline copy with
            no signal, and the line that says so on every page. */}
        <RegisterServiceWorker />
        <OfflineBanner />
        {/* 0121: sign-out after the org's idle limit, and a second factor
            set up first where the role requires one. */}
        <IdleGuard idleMinutes={session.idle} act={session.act} />
        <MfaGate pending={session.mfaReq && !session.mfa} />
        {children}
      </main>
    </div>
  );
}
