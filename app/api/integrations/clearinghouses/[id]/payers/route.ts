/**
 * /api/integrations/clearinghouses/[id]/payers — the payer ID this
 * clearinghouse knows each payer by (0120; 837P 2010BB NM109), and the claim
 * filing indicator when the payer's type does not say it.
 *
 *   GET   every active payer, the practice's most-billed first, with its mapping
 *   PUT   { rows: [{ payerId, externalPayerId | null, claimFilingIndicator | null }] }
 *         (null externalPayerId removes the mapping)
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJsonAs, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listPayerIds, setPayerIds } from "@/lib/features/clearinghouse/connection.service";

interface Params {
  params: Promise<{ id: string }>;
}

const Body = z
  .object({
    rows: z
      .array(
        z.object({
          payerId: z.string().uuid(),
          externalPayerId: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9]{2,80}$/, "A payer ID is 2-80 letters or digits.")
            .nullable()
            .or(z.literal("").transform(() => null)),
          claimFilingIndicator: z
            .string()
            .trim()
            .regex(/^[0-9A-Z]{2}$/, "A claim filing indicator is two characters (MB, MC, CI, 16 …).")
            .nullable()
            .or(z.literal("").transform(() => null)),
        }),
      )
      .max(500),
  })
  .strict();

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok({ payers: await listPayerIds({ orgId: session.orgId, connectionId: id }) });
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
  const body = await parseJsonAs(req, Body);
  if (body instanceof Response) return body;
  try {
    return ok({ payers: await setPayerIds({ orgId: session.orgId, userId: session.userId, connectionId: id, rows: body.rows }) });
  } catch (err) {
    return handleServiceError(err);
  }
}
