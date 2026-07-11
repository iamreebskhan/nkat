/**
 * GET /api/cheatsheets/templates — org-side list of published
 * cheat-sheet templates (Phase G). Returns only rows where
 * status='published'; non-platform-admin callers never see
 * pending_review or withdrawn.
 *
 * Auth: cheatsheets.view (same perm that gates the cheat-sheet page).
 */
import { type NextRequest } from "next/server";

import { ok, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listPublishedForOrg } from "@/lib/features/cheatsheets/template.service";

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await requireAuth(["cheatsheets.view"]);
  if (session instanceof Response) return session;
  try {
    const rows = await listPublishedForOrg();
    return ok({ rows, total: rows.length });
  } catch (err) {
    return handleServiceError(err);
  }
}
