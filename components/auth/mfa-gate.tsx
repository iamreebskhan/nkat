"use client";

/**
 * Sends a session that still owes a second factor to Settings → Security
 * (0121). Every API route already refuses such a session (requireAuth), so
 * this only spares the person a page of errors: it happens after signup or an
 * invite to an admin or billing role, and when the org's policy changes under
 * a session in use. In that last case `pending` is only as new as the page
 * load, because a layout does not re-render on an in-app navigation: IdleGuard
 * hears of it at the session's refresh and asks the person to go.
 */
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

export const MFA_SETUP_PATH = "/settings/security";

export function MfaGate({ pending }: { pending: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (pending && !pathname.startsWith(MFA_SETUP_PATH)) router.replace(`${MFA_SETUP_PATH}?required=1`);
  }, [pending, pathname, router]);
  return null;
}
