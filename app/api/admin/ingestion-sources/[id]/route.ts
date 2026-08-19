/**
 * PATCH  /api/admin/ingestion-sources/[id] — edit one source.
 * DELETE /api/admin/ingestion-sources/[id] — stop re-checking it.
 *
 * Platform-admin only, same gate as the list/create route next door.
 *
 * WHY THESE EXIST NOW. There was no way to change a source once registered:
 * POST to create, GET to list, POST .../run to trigger, and nothing else.
 * A source pointed at the wrong payer, or at a test fixture, was permanent
 * from the operator UI and could only be fixed with SQL on the box. That is
 * exactly how a fixture source stayed registered long enough to displace ten
 * Medicare rules the moment ingestion started working.
 *
 * Deleting a source does NOT delete the documents or rules it produced —
 * those are cited by live rules, and erasing the provenance of an answer to
 * tidy up a config row would be the worse bug. It only stops future runs.
 */
import { type NextRequest } from "next/server";

import { ok, fail, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  UpdateSourceSchema,
  updateSource,
  deleteSource,
} from "@/lib/features/ingestion/sources.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  const body = await parseJson(req, UpdateSourceSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updateSource(id, body));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  try {
    return ok(await deleteSource(id));
  } catch (err) {
    return handleServiceError(err);
  }
}
