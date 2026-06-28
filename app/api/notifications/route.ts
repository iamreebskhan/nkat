/**
 * GET   /api/notifications        — caller's notifications + unread count
 * PATCH /api/notifications        — mark read ({ id } for one, omit for all)
 *
 * Phase F: powers the sidebar bell badge + dropdown.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listNotifications,
  markNotificationsRead,
} from "@/lib/features/notifications/notification.service";

const Query = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const result = await listNotifications({
    orgId: session.orgId,
    userId: session.userId,
    unreadOnly: params.unreadOnly,
    limit: params.limit,
  });
  return ok(result);
}

const PatchBody = z.object({ id: z.string().uuid().optional() });

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const body = await parseJson(req, PatchBody);
  if (body instanceof Response) return body;
  const r = await markNotificationsRead({
    orgId: session.orgId,
    userId: session.userId,
    id: body.id,
  });
  return ok(r);
}
