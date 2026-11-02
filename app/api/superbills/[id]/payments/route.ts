/**
 * POST /api/superbills/[id]/payments — another payment on a partially paid
 * claim (D9): added to what is recorded, with a line on the claim history.
 * See recordFurtherPayment. A first payment is a status move, on .../status.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { recordFurtherPayment } from "@/lib/features/superbills/superbill.service";

const Body = z
  .object({
    // The same sanity bound as a first payment; the claim itself is the real
    // one, which only the service can see.
    amountCents: z.number().int().min(1).max(100_000_000),
    /** "The payer will pay nothing more": the claim closes as paid at the new total. */
    last: z.boolean().optional(),
    /** "Yes, the payer paid more than this claim billed." */
    overpaymentAcknowledged: z.boolean().optional(),
  })
  .strict();

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    return ok(await recordFurtherPayment({ orgId: session.orgId, id, actorUserId: session.userId, ...body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
