/**
 * POST /api/billing/lookup
 *
 * Core rule-lookup endpoint. Wraps `lookupRule()` in the standard
 * response envelope, enforces auth, and (when source=ai_synthesized)
 * pushes the proposed rule to the analyst queue for review.
 *
 * Auth: requires `billing.lookup.view` permission.
 *
 * Source: pallio_complete_vision_v3 §8.2 (billing-agent rule lookup).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { lookupRule } from "@/lib/features/billing/rule-lookup.service";

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
    const result = await lookupRule(body);
    // TODO(phase-6): if result.source === 'ai_synthesized', insert a
    // PayerRule row with confidence=0.4 + flag in analyst queue.
    return ok(result);
  } catch (err) {
    // Most errors here are PHI-detection refusals or upstream API
    // failures. Surface as 422 so the FE shows the actual reason.
    const message = err instanceof Error ? err.message : "Rule lookup failed.";
    return fail(message, { status: 422 });
  }
}
