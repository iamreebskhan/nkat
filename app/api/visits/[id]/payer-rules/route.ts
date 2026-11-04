/**
 * POST /api/visits/[id]/payer-rules — the patient's payer's rules for codes on
 * this visit, as they stood on the visit's date of service.
 *
 * The documentation screen's "Payer rules" panel. It asked POST
 * /api/billing/lookup, which needs billing.lookup.view; the clinician role
 * deliberately holds no billing.* permission (lib/features/team/team.types.ts),
 * so for every clinician each lookup was refused and the panel read
 * "checking…" for good. This answers the same lookup for a visit the caller
 * may open, and no other: the payer, the coverage state and the date of service
 * come from the visit, not from the request. The Rule lookup page, with its
 * free-text questions about any payer, stays behind billing.lookup.view.
 *
 * Body: { codes: string[] (1-10), attribute?: as POST /api/billing/lookup }
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, handleServiceError, ok, parseJson, requireUuidParam, NotFoundError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
import { getVisitPayerRules } from "@/lib/features/visits/visit-payer-rules.service";

interface Params {
  params: Promise<{ id: string }>;
}

/** The note's own door: whoever may read a visit's documentation. */
const CLINICAL_READ = ["visits.view.all", "visits.view.own", "visits.edit"];

const Schema = z.object({
  codes: z
    .array(z.string().regex(/^([A-Z]\d{4}|\d{4}[A-Z\d]|\d{5})$/, "Invalid CPT/HCPCS code"))
    .min(1)
    .max(10),
  attribute: z
    .enum([
      "covered",
      "prior_auth",
      "telehealth",
      "provider_type",
      "billing_limit",
      "addon_compatible",
      "documentation",
      "frequency_limit",
      "modifier_required",
      "pos_allowed",
    ])
    .optional(),
});

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (!CLINICAL_READ.some((p) => session.permissions.includes(p))) {
    return fail("Permission denied.", { status: 403 });
  }

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // Whose visit this is: a .own caller reads their own visits, and the
  // patient's care team reads theirs (visit-access.ts). Before the body, so a
  // refused caller learns nothing from its validation.
  const denied = await requireVisitAccess({ session, visitId: id, access: "read" });
  if (denied) return denied;

  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  try {
    return ok(
      await getVisitPayerRules({
        orgId: session.orgId,
        visitId: id,
        codes: body.codes,
        attribute: body.attribute ?? "covered",
      }),
    );
  } catch (err) {
    if (err instanceof NotFoundError) return handleServiceError(err);
    // As POST /api/billing/lookup: most failures here are a PHI-guard refusal
    // or the model being unreachable, and the panel shows the reason.
    const message = err instanceof Error ? err.message : "Rule lookup failed.";
    return fail(message, { status: 422 });
  }
}
