/**
 * PATCH /api/superbills/[id]
 *
 * Edit a draft superbill — Phase A's payer-scoped CPT picker writes
 * here. Only drafts can be edited; once status moves past 'draft',
 * the superbill is immutable through this path (use the dedicated
 * transition endpoints).
 *
 * Body:
 *   patch:      { cptCodes?, icd10Codes?, modifiers? }
 *   overrides:  [{ code, reason }]  -- codes selected outside the
 *               payer's allow-list. Each override is written to
 *               audit_log as event "superbill_code_override" with
 *               the reason for compliance.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { updateSuperbill } from "@/lib/features/superbills/superbill.service";

const PatchSchema = z.object({
  patch: z.object({
    cptCodes: z.array(z.string().min(1).max(10)).max(50).optional(),
    icd10Codes: z.array(z.string().min(1).max(10)).max(50).optional(),
    modifiers: z.array(z.string().min(1).max(4)).max(20).optional(),
  }),
  overrides: z
    .array(
      z.object({
        code: z.string().min(1).max(10),
        reason: z.string().min(3).max(500),
      }),
    )
    .max(50)
    .optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.create"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, PatchSchema);
  if (body instanceof Response) return body;

  try {
    const result = await updateSuperbill({
      orgId: session.orgId,
      id,
      userId: session.userId,
      patch: body.patch,
      overrides: body.overrides,
    });
    return ok(result);
  } catch (err) {
    return handleServiceError(err);
  }
}
