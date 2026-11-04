/**
 * POST /api/billing/lookup
 *
 * Core rule-lookup endpoint. Wraps `lookupRule()` in the standard
 * response envelope, enforces auth, and (when source=ai_synthesized)
 * persists the synthesized rule into the corpus + flags it for
 * analyst review. Self-reinforcing knowledge base.
 *
 * Auth: requires `billing.lookup.view` permission.
 *
 * Source: pallio_complete_vision_v3 §8.2 (billing-agent rule lookup).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { lookupRule } from "@/lib/features/billing/rule-lookup.service";
import { persistSynthesizedRule } from "@/lib/features/billing/synthesized-rule.service";

const Schema = z.object({
  query: z.string().max(500).optional(),
  payerId: z.string().uuid().optional(),
  state: z.string().length(2).optional(),
  cptCode: z
    .string()
    .regex(/^([A-Z]\d{4}|\d{4}[A-Z\d]|\d{5})$/, "Invalid CPT/HCPCS code")
    .optional(),
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
      // Place of service decides whether a home visit billed POS 12
      // is paid at all. 123 rules answer it, and none was reachable by
      // any query until this enum listed it.
      "pos_allowed",
    ])
    .optional(),
  dos: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (YYYY-MM-DD)").optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.lookup.view"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  // The lookupRule service handles its own PHI guard, missing-fields,
  // and AI-availability fallbacks. The route is just plumbing + audit.
  try {
    // orgId is taken from the SESSION, never from the request body —
    // it selects which tenant's rulebook answers the lookup, so a
    // client-supplied value would be a cross-tenant read.
    const result = await lookupRule({ ...body, orgId: session.orgId });

    // Self-reinforcing corpus (closes the long-standing phase-6 TODO):
    // when the engine synthesizes an answer from RAG, persist it as a
    // low-confidence payer_rule + queue it for an analyst to confirm.
    // Next lookup with the same key hits the SQL path → no AI cost,
    // same answer, faster. If the analyst voids it, the rule expires.
    if (result.status === "ok" && result.source === "ai_synthesized") {
      await persistSynthesizedRule(result, session.orgId).catch((e) => {
        console.warn("ai_synthesized persist failed (non-fatal):", e);
      });
    }

    return ok(result);
  } catch (err) {
    // Most errors here are PHI-detection refusals or upstream API
    // failures. Surface as 422 so the FE shows the actual reason.
    const message = err instanceof Error ? err.message : "Rule lookup failed.";
    return fail(message, { status: 422 });
  }
}
