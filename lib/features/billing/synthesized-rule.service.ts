/**
 * What a rule lookup does with an answer the AI wrote.
 *
 * Shared by POST /api/billing/lookup and POST /api/visits/[id]/payer-rules,
 * which answer the same lookup for two kinds of caller: an AI-written answer is
 * kept and queued for review whichever of them produced it.
 */
import { pushAttestationRequest } from "@/lib/features/attestations/attestation.service";
import { upsertOrgRule } from "@/lib/features/rulebook/org-rule.repository";

import type { lookupRule } from "./rule-lookup.service";

/**
 * Side-effect: cache the synthesized answer in THIS ORG'S rulebook
 * (confidence=0.4, origin='source') and push the same key to the
 * analyst attestation queue so a human verifies it.
 *
 * Why the org's rulebook and not the global `payer_rule` library:
 * this row is an unreviewed 0.4-confidence AI answer produced by one
 * tenant's query. Writing it globally — which is what this function
 * used to do — silently made it the platform's answer for every other
 * tenant too. It stays with the org that asked, and answers no lookup
 * until an analyst confirms it (fetchOrgRule reads only rows a person
 * decided). `payer_rule` is now written only by platform ingestion.
 *
 * Best-effort: failures are logged but don't surface to the caller —
 * the user already has their answer.
 */
export async function persistSynthesizedRule(
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
