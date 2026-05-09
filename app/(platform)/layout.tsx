/**
 * Platform layout — wraps all authenticated routes.
 *
 * Reads the session server-side. If unauth'd, redirect to /login. If
 * the role has a manifest, render the sidebar with role-specific
 * navigation; otherwise show a minimal shell (consultants with no
 * grants land here until the org admin invites them properly).
 */
import { redirect } from "next/navigation";

import { Sidebar } from "@/components/sidebar";
import { getSession } from "@/lib/auth";
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

  return (
    <div className="flex min-h-screen">
      <Sidebar
        items={items}
        userEmail={session.email}
        orgName={undefined /* TODO: fetch org name in lookup query */}
      />
      <main className="flex-1 min-w-0 bg-[var(--color-canvas)]">
        {children}
      </main>
    </div>
  );
}
