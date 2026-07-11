/**
 * POST /api/superbills/[id]/status — the dedicated transition endpoint the
 * PATCH route's doc comment has always pointed at (previously never built,
 * leaving markStatus and the submitted/paid bookkeeping unreachable).
 *
 * Body: { to: SuperbillStatus, paidAmountCents? }
 * Legal moves are validated in the service (draft → ready_to_submit →
 * submitted → paid | partially_paid | denied | voided; denied → submitted
 * for refiles). submitted_at / paid_at / paid_amount_cents are stamped by
 * the service per transition.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { NotFoundError, fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  SUPERBILL_STATUSES,
  markStatus,
} from "@/lib/features/superbills/superbill.service";

const Body = z
  .object({
    to: z.enum(SUPERBILL_STATUSES),
    paidAmountCents: z.number().int().min(0).max(100_000_000).optional(),
  })
  .refine(
    (b) => !["paid", "partially_paid"].includes(b.to) || b.paidAmountCents !== undefined,
    { message: "paidAmountCents is required when marking paid or partially_paid." },
  );

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  const { id } = await ctx.params;
  // Validate before the raw query — a non-UUID id would surface Postgres
  // 22P02 through Prisma's error text, leaking query detail to the client.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return fail("Superbill not found.", { status: 404 });
  }
  try {
    const r = await markStatus({
      orgId: session.orgId,
      id,
      to: body.to,
      paidAmountCents: body.paidAmountCents,
    });
    return ok(r);
  } catch (err) {
    if (err instanceof NotFoundError) return fail(err.message, { status: 404 });
    // Only the domain violation is client-caused and safe to echo; anything
    // else (Prisma/DB faults) is a server error and must not leak internals.
    if (err instanceof Error && err.message.startsWith("Illegal superbill transition")) {
      return fail(err.message, { status: 422 });
    }
    return fail("Transition failed.", { status: 500 });
  }
}
