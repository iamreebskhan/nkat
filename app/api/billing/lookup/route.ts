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
import { ATTRIBUTE_DB_MAP } from "@/lib/features/billing/payer-rule.repository";
import { lookupRule } from "@/lib/features/billing/rule-lookup.service";
import { refreshOrgRulebookRowsForRule } from "@/lib/features/rulebook/rulebook.service";
import { prisma } from "@/lib/db";

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
 * Side-effect: write a payer_rule (confidence=0.4, created_by='ai')
 * referencing the citation's source_document, and push the same key
 * to the analyst attestation queue so a human verifies before it gets
 * promoted to higher confidence.
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

  // Prefer the source_doc_id the engine carried from the top RAG
  // chunk; fall back to a URL lookup if (legacy) callers don't carry
  // it. Without one, we can't satisfy payer_rule.source_doc_id NOT
  // NULL, so we skip the persist rather than write a dangling row.
  let sourceDocId = result.sourceDocId ?? null;
  if (!sourceDocId) {
    const url = result.citation.documentUrl;
    if (!url) return;
    const docs = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM source_document WHERE url = ${url} LIMIT 1
    `;
    if (docs.length === 0) return;
    sourceDocId = docs[0]!.id;
  }

  const dbAttr =
    ATTRIBUTE_DB_MAP[result.resolved.attribute as keyof typeof ATTRIBUTE_DB_MAP] ??
    result.resolved.attribute;

  // Don't double-insert the global payer_rule if we've already
  // persisted for this exact key. We still queue an attestation
  // request for THIS org below — each tenant gets their own gap
  // flagged even when the global rule already exists.
  const dup = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM payer_rule
     WHERE payer_id = ${result.resolved.payerId}::uuid
       AND state    = ${result.resolved.state}
       AND code     = ${result.resolved.cptCode}
       AND attribute = ${dbAttr}
       AND created_by = 'ai'
       AND expiration_date IS NULL
     LIMIT 1
  `;
  const alreadyPersisted = dup.length > 0;

  if (!alreadyPersisted) {
    const ins = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO payer_rule (
      payer_id, state, product_line, code, attribute,
      value, coverage_status, confidence,
      effective_date, expiration_date,
      source_doc_id, source_quote,
      created_by
    ) VALUES (
      ${result.resolved.payerId}::uuid, ${result.resolved.state}, 'commercial',
      ${result.resolved.cptCode}, ${dbAttr},
      ${JSON.stringify({ answer: result.answer })}::jsonb,
      ${result.coverageStatus}, 0.40,
      CURRENT_DATE, NULL,
      ${sourceDocId}::uuid,
      ${result.citation.verbatimQuote},
      'ai'
    )
    RETURNING id
  `;

    // Cross-org rulebook refresh — every org with this (payer/state/code)
    // cell now reflects the AI-synthesized data instead of an "unknown"
    // placeholder. Lookups already query payer_rule directly so they
    // would see the new row; this keeps the rulebook display in sync.
    await refreshOrgRulebookRowsForRule({
      ruleId: ins[0]!.id,
      payerId: result.resolved.payerId,
      state: result.resolved.state,
      cptCode: result.resolved.cptCode,
      dbAttribute: dbAttr,
      coverageStatus: result.coverageStatus,
      ruleValue: { answer: result.answer },
      confidence: 0.4,
      sourceQuote: result.citation.verbatimQuote,
    });
  }

  // Queue an attestation request FOR THIS ORG (even when the global
  // rule was already persisted by a prior session). Every tenant
  // should see the gap in their queue and be able to confirm or
  // re-confirm it independently. analyst_attestation_request is
  // tenant-scoped via RLS so no leak across orgs.
  await pushAttestationRequest({
    orgId,
    payerId: result.resolved.payerId,
    state: result.resolved.state,
    cptCode: result.resolved.cptCode,
    attribute: result.resolved.attribute ?? "covered",
    sourceQuery: `AI-synthesized rule, conf=0.4, cited from ${result.citation.documentName}`,
  });
}
