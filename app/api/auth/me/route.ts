/**
 * GET  /api/auth/me   — session payload + persisted full_name.
 * PATCH /api/auth/me  — update the authenticated user's full_name.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return fail("Not authenticated.", { status: 401 });

  // app_user has no org_id → no RLS — safe to read directly.
  const rows = await prisma.$queryRaw<
    { full_name: string | null; last_login_at: Date | null }[]
  >`
    SELECT full_name, last_login_at FROM app_user WHERE id = ${session.userId}::uuid LIMIT 1
  `;
  const me = rows[0];

  return ok({
    userId: session.userId,
    orgId: session.orgId,
    email: session.email,
    role: session.role,
    permissions: session.permissions,
    fullName: me?.full_name ?? null,
    lastLoginAt: me?.last_login_at?.toISOString() ?? null,
  });
}

const PatchSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
});

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) return fail("Not authenticated.", { status: 401 });

  const body = await parseJson(req, PatchSchema);
  if (body instanceof Response) return body;

  await prisma.$executeRaw`
    UPDATE app_user SET full_name = ${body.fullName}
    WHERE id = ${session.userId}::uuid
  `;
  return ok({ fullName: body.fullName });
}
