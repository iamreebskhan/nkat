/**
 * PATCH /api/superbills/[id]
 *
 * Edit a draft superbill — Phase A's payer-scoped CPT picker writes
 * here. Only drafts can be edited; once status moves past 'draft',
 * the superbill is immutable through this path (use the dedicated
 * transition endpoints).
 *
 * Body:
 *   patch:      { cptCodes?, cptUnits?, icd10Codes?, modifiers?, placeOfServiceCode? }
 *               cptUnits is units per code when more than one, e.g.
 *               {"G0318": 3} (0106). Only G0318, 99417 and 99498 take units;
 *               any other code with more than one is refused with a 422.
 *               Codes or units written reprice the bill, and the result's
 *               cptUnits is the map as written.
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
    /** Units per code (0106): whole numbers 1–99, the same bound as the column's CHECK. */
    cptUnits: z.record(z.string().min(1).max(10), z.number().int().min(1).max(99)).optional(),
    icd10Codes: z.array(z.string().min(1).max(10)).max(50).optional(),
    modifiers: z.array(z.string().min(1).max(4)).max(20).optional(),
    /** Where the visit took place (audit R23): a two-digit CMS code. */
    placeOfServiceCode: z.string().regex(/^\d{2}$/).optional(),
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
