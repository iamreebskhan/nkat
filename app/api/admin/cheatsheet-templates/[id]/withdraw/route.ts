/** POST /api/admin/cheatsheet-templates/[id]/withdraw — platform_admin only. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withdrawTemplate } from "@/lib/features/cheatsheets/template.service";

const Body = z.object({ notes: z.string().max(500).optional() });

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin access required.", { status: 403 });
  }
  const { id } = await ctx.params;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  const r = await withdrawTemplate({ id, userId: session.userId, notes: body.notes });
  if (!r.withdrawn) return fail("Template not found or not published.", { status: 404 });
  return ok({ withdrawn: true });
}
