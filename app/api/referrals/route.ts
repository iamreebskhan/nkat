/**
 * The referral board (Level-1 doc:24, 0111).
 *
 *   GET  — referrals by stage (?filter=open|all|<stage>, ?q=), with the board's
 *          counts and conversion when ?summary=1, and the practice's today
 *   POST — a referral received
 *
 * Reading needs patients.view: the triaging nurse reads the board too.
 * Receiving one needs patients.create, intake's grant (org admin, intake
 * coordinator).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  createReferral,
  getReferralSummary,
  listReferrals,
  referralToday,
} from "@/lib/features/referrals/referral.service";
import { CreateReferralSchema, REFERRAL_STAGES } from "@/lib/features/referrals/referral.types";

const Query = z.object({
  filter: z.enum(["open", "all", ...REFERRAL_STAGES]).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  summary: z.enum(["1"]).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  try {
    const rows = await listReferrals({
      orgId: session.orgId,
      filter: params.filter,
      q: params.q,
      limit: params.limit,
    });
    const summary = params.summary ? await getReferralSummary(session.orgId) : undefined;
    // The new-referral form's default received day: the practice's, not the
    // browser's, which can already be tomorrow.
    return ok({ rows, summary, today: await referralToday(session.orgId) });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["patients.create"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, CreateReferralSchema);
  if (body instanceof Response) return body;
  try {
    const r = await createReferral({ orgId: session.orgId, userId: session.userId, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
