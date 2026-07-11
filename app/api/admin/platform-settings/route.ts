/**
 * GET  /api/admin/platform-settings — list system_setting + rate_limit_override
 * POST /api/admin/platform-settings { key, value, note? } — upsert one
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  KNOWN_SETTINGS,
  listRateLimitOverrides,
  listSettings,
  upsertSetting,
} from "@/lib/features/admin/platform-settings.service";

const Body = z.object({
  key: z.string().min(1).max(120),
  value: z.unknown(),
  note: z.string().max(500).nullable().optional(),
});

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const [settings, overrides] = await Promise.all([
    listSettings(),
    listRateLimitOverrides(),
  ]);
  return ok({
    catalog: KNOWN_SETTINGS,
    settings,
    rateLimitOverrides: overrides,
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  const r = await upsertSetting({
    key: body.key,
    value: body.value,
    note: body.note ?? null,
    byUserId: session.userId,
  });
  return ok(r);
}
