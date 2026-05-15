/**
 * POST /api/auth/change-password
 *
 * Authenticated rotation: requires current password + new password
 * (≥12 chars). Separate from /api/auth/password/* which is the
 * forgot-password token flow.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { changePassword } from "@/lib/features/auth/change-password.service";

const Body = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12, "New password must be at least 12 characters").max(200),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;

  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  const r = await changePassword({
    userId: session.userId,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });
  if ("error" in r) {
    if (r.error === "current_wrong") {
      return fail("Current password is incorrect.", { status: 401 });
    }
    if (r.error === "weak_password") {
      return fail("New password must be at least 12 characters.", { status: 422 });
    }
    return fail("Could not change password.", { status: 422 });
  }
  return ok({ rotated: true });
}
