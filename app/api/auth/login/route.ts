/**
 * POST /api/auth/login
 *
 * Phase 1 dev shim — issues a session cookie for any email when
 * NODE_ENV=development, with a role inferred from a `?role=` query
 * param (default `org_admin`). This unblocks the frontend shell while
 * the full user/password/bcrypt flow is built in Phase 2.
 *
 * The real implementation will:
 *   1. Look up the user by email in the `app_user` table
 *   2. Verify the bcrypt hash
 *   3. Load `user_permission` rows for the user × org pair
 *   4. Sign a session JWT including those permissions
 *   5. Set the HttpOnly cookie + return ok({ redirectTo })
 *
 * NEVER deploy this shim to production. The route enforces dev-only
 * via env().NODE_ENV check below.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { setSessionCookie, signSession, type Session } from "@/lib/auth";
import { env } from "@/lib/env";

const Schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// All permission strings — used to grant org_admin everything in dev.
const ALL_PERMISSIONS = [
  "patients.list", "patients.view", "patients.create", "patients.edit", "patients.archive",
  "visits.view.own", "visits.view.all", "visits.create", "visits.edit", "visits.submit",
  "careplans.view", "careplans.edit",
  "schedule.view", "schedule.create", "schedule.edit",
  "billing.lookup.view", "billing.lookup.export",
  "billing.superbills.view", "billing.superbills.create", "billing.superbills.edit", "billing.superbills.export",
  "billing.denials.view", "billing.denials.log", "billing.denials.refile", "billing.denials.writeoff",
  "cheatsheets.view", "cheatsheets.generate", "cheatsheets.download",
  "knowledge.view", "knowledge.upload", "knowledge.attest", "knowledge.edit",
  "reports.view", "reports.export",
  "team.view", "team.invite", "team.permissions", "team.deactivate",
  "settings.view", "settings.org", "settings.payers", "settings.integrations",
  "audit.view",
];

export async function POST(req: NextRequest): Promise<Response> {
  if (env().NODE_ENV === "production") {
    return fail("Not implemented in production yet.", { status: 501 });
  }

  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  const { email } = body;

  // Dev shim — derive role from email prefix for quick role-switching:
  //   clinician@... → clinician
  //   billing@...   → billing_agent
  //   analyst@...   → analyst
  //   admin@... or anything else → org_admin
  const role: Session["role"] = email.startsWith("clinician@")
    ? "clinician"
    : email.startsWith("billing@")
      ? "billing_agent"
      : email.startsWith("analyst@")
        ? "analyst"
        : email.startsWith("readonly@")
          ? "read_only"
          : email.startsWith("platform@")
            ? "platform_admin"
            : "org_admin";

  const session: Session = {
    userId: "00000000-0000-0000-0000-000000000001",
    orgId: "00000000-0000-0000-0000-000000000aaa",
    role,
    permissions: ALL_PERMISSIONS,  // dev: everything granted
    email,
  };

  const token = await signSession(session);
  await setSessionCookie(token);

  return ok({ redirectTo: "/" });
}
