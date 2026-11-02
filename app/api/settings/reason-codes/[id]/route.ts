/**
 * PATCH /api/settings/reason-codes/[id] — rename, recategorise, retire or
 * bring back a code. No DELETE and no renumbering: past dispositions carry
 * the code, and the reports match on its number.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { updateReasonCode } from "@/lib/features/referrals/reason-code.service";
import { REASON_CATEGORIES } from "@/lib/features/referrals/reason-codes";

interface Params {
  params: Promise<{ id: string }>;
}

const UpdateReasonCodeSchema = z
  .object({
    label: z.string().trim().min(1, "Name the reason").max(120),
    category: z.enum(REASON_CATEGORIES),
    active: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, UpdateReasonCodeSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updateReasonCode({ orgId: session.orgId, userId: session.userId, id, patch: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
