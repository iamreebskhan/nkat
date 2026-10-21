/**
 * PATCH /api/admin/payers/[id] — edit one payer, or withdraw it from the
 *                                pickers with { active: false }.
 *
 * Platform-admin only, same gate as the list/create route next door.
 *
 * There is no DELETE, on purpose. Patients, superbills and every payer_rule
 * reference the payer by id, and a retired plan still has to name itself on
 * the charts and claims that used it. Deactivating hides it from new picks
 * (listPayers returns active rows only) and keeps the history readable
 * (audit R17).
 */
import { type NextRequest } from "next/server";

import { ok, fail, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { UpdatePayerSchema, updatePayer } from "@/lib/features/billing/payer-admin.service";

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

  const body = await parseJson(req, UpdatePayerSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updatePayer({ orgId: session.orgId, userId: session.userId, id, patch: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
