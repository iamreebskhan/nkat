/**
 * The practice's discharge and NTUC reason codes (0111).
 *
 *   GET  — the codes (?kind=discharge|ntuc; ?includeRetired=1 for settings)
 *   POST — add one (Settings → Reason codes)
 *
 * Reading is for whoever records a disposition: intake (NTUC) and the
 * clinical team (discharge). Changing them is the org's settings grant.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, handleServiceError, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { createReasonCode, listReasonCodes } from "@/lib/features/referrals/reason-code.service";
import { REASON_CATEGORIES, REASON_CODE_KINDS } from "@/lib/features/referrals/reason-codes";

const READ_ANY = ["patients.view", "settings.view"];

const Query = z.object({
  kind: z.enum(REASON_CODE_KINDS).optional(),
  includeRetired: z.enum(["1"]).optional(),
});

const CreateReasonCodeSchema = z
  .object({
    kind: z.enum(REASON_CODE_KINDS),
    code: z.string().trim().toLowerCase().regex(/^[0-9]{2}[a-z]?$/, "Two digits and an optional letter, like 21c"),
    label: z.string().trim().min(1, "Name the reason").max(120),
    category: z.enum(REASON_CATEGORIES),
  })
  .strict();

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!READ_ANY.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  try {
    const codes = await listReasonCodes({
      orgId: session.orgId,
      kind: params.kind,
      includeRetired: params.includeRetired === "1",
    });
    return ok({ codes });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, CreateReasonCodeSchema);
  if (body instanceof Response) return body;
  try {
    const code = await createReasonCode({ orgId: session.orgId, userId: session.userId, ...body });
    return ok(code, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
