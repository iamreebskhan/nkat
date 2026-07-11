/** POST /api/admin/cheatsheet-templates/[id]/publish — platform_admin only. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { publishTemplate } from "@/lib/features/cheatsheets/template.service";

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
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  const r = await publishTemplate({ id, userId: session.userId, notes: body.notes });
  if (!r.published) return fail("Template not found or not in publishable state.", { status: 404 });
  return ok({ published: true });
}
