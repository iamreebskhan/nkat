/**
 * /api/integrations/clearinghouses/[id] — one connection (0120).
 *
 *   GET     the connection (no secrets)
 *   PUT     its settings, with secrets as a patch (a string sets, null clears, absent keeps)
 *   PATCH   { status: "active" | "disabled" }
 *   DELETE  remove it; files sent through it keep their history
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, parseJsonAs, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { ConnectionInputSchema } from "@/lib/features/clearinghouse/connection-settings";
import {
  deleteConnection,
  getConnection,
  setConnectionStatus,
  updateConnection,
} from "@/lib/features/clearinghouse/connection.service";

interface Params {
  params: Promise<{ id: string }>;
}

const StatusBody = z.object({ status: z.enum(["active", "disabled"]) }).strict();

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await getConnection({ orgId: session.orgId, id }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJsonAs(req, ConnectionInputSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updateConnection({ orgId: session.orgId, userId: session.userId, id, input: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, StatusBody);
  if (body instanceof Response) return body;
  try {
    return ok(await setConnectionStatus({ orgId: session.orgId, userId: session.userId, id, status: body.status }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    await deleteConnection({ orgId: session.orgId, userId: session.userId, id });
    return ok({ deleted: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
