/** GET /api/admin/cheatsheet-templates — platform_admin only. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listTemplates,
  scanForCandidates,
} from "@/lib/features/cheatsheets/template.service";

const Query = z.object({
  status: z.enum(["pending_review", "published", "withdrawn"]).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin access required.", { status: 403 });
  }
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const rows = await listTemplates({ status: params.status });
  return ok({ rows, total: rows.length });
}

/** POST = re-scan candidates (manual fire from Super Panel). */
export async function POST(_req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin access required.", { status: 403 });
  }
  const summary = await scanForCandidates();
  return ok(summary);
}
