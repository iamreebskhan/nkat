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
import { pushAttestationRequest } from "@/lib/features/attestations/attestation.service";
import { lookupRule } from "@/lib/features/billing/rule-lookup.service";
import { upsertOrgRule } from "@/lib/features/rulebook/org-rule.repository";

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

/**
 * Side-effect: cache the synthesized answer in THIS ORG'S rulebook
 * (confidence=0.4, origin='source') and push the same key to the
 * analyst attestation queue so a human verifies it.
 *
 * Why the org's rulebook and not the global `payer_rule` library:
 * this row is an unreviewed 0.4-confidence AI answer produced by one
 * tenant's query. Writing it globally — which is what this function
 * used to do — silently made it the platform's answer for every other
 * tenant too. The org keeps the benefit (next identical lookup hits
 * the org-rulebook step, no AI cost, same answer) without exporting an
 * unverified rule to 100+ other practices. `payer_rule` is now written
 * only by platform ingestion.
 *
 * Best-effort: failures are logged but don't surface to the caller —
 * the user already has their answer.
 */
async function persistSynthesizedRule(
  result: Awaited<ReturnType<typeof lookupRule>>,
  orgId: string,
): Promise<void> {
  if (result.status !== "ok" || result.source !== "ai_synthesized") return;
  if (!result.citation) return;
  if (!result.resolved.payerId || !result.resolved.state || !result.resolved.cptCode) return;

  await upsertOrgRule({
    orgId,
    payerId: result.resolved.payerId,
    state: result.resolved.state,
    code: result.resolved.cptCode,
    attribute: result.resolved.attribute ?? "covered",
    coverageStatus: result.coverageStatus,
    ruleValue: { answer: result.answer },
    confidence: 0.4,
    origin: "source",
    sourceQuote: result.citation.verbatimQuote,
    // A machine guess must never overwrite what a human in this org
    // deliberately set.
    preserveOverride: true,
  });

  // Queue an attestation request FOR THIS ORG so a human confirms the
  // guess. analyst_attestation_request is tenant-scoped via RLS.
  await pushAttestationRequest({
    orgId,
    payerId: result.resolved.payerId,
    state: result.resolved.state,
    cptCode: result.resolved.cptCode,
    attribute: result.resolved.attribute ?? "covered",
    sourceQuery: `AI-synthesized rule, conf=0.4, cited from ${result.citation.documentName}`,
  });
}
