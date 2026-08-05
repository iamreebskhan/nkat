/**
 * PATCH /api/settings/visit-services/[id]
 *
 * Rename, recategorise, or deactivate a catalog service.
 *
 * There is no DELETE by design: historical visits reference these rows, and a
 * deleted service would leave a past encounter unlabelled. Set `active: false`
 * to take it out of the picker while the record stays readable.
 */
import { type NextRequest } from "next/server";

import { ok, handleServiceError, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  UpdateServiceSchema,
  updateService,
} from "@/lib/features/visits/visit-services.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  const body = await parseJson(req, UpdateServiceSchema);
  if (body instanceof Response) return body;

  try {
    const r = await updateService({ orgId: session.orgId, id, payload: body });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
