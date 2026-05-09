/**
 * POST /api/rulebook/generate
 *
 * Path A — build a fresh rulebook from the org's onboarding inputs
 * (states + payer_ids + cpt_codes). Pulls every matching rule from
 * the global `payer_rule` library; emits 'unknown' placeholders for
 * gaps so the org admin can see where source coverage is missing.
 *
 * Idempotent on a per-org basis — re-running bumps the version.
 */
import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getOrCreateOnboarding } from "@/lib/features/onboarding/onboarding.service";
import { generateRulebook } from "@/lib/features/rulebook/rulebook.service";

export async function POST(): Promise<Response> {
  const session = await requireAuth(["knowledge.edit"]);
  if (session instanceof Response) return session;

  // Pull the active states/payers/cpts from the onboarding row. Org
  // admin must have completed at least Profile + States + Payers +
  // CPT before generating.
  const onb = await getOrCreateOnboarding(session.orgId);
  if (!onb.statesComplete || !onb.payersComplete || !onb.cptCodesComplete) {
    return fail(
      "Complete states, payers, and CPT codes in the onboarding wizard first.",
      { status: 422 },
    );
  }

  // Pull the org's CPT set from `org_cpt_code_set` — saveCptCodes
  // already persisted them. We hit the table directly here to keep
  // the rulebook service framework-free.
  // (Direct SQL via Prisma; no service abstraction needed for one query.)
  const { prisma, withOrgContext } = await import("@/lib/db");
  void prisma;
  const cptCodes = await withOrgContext(session.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ cpt_code: string }[]>`
      SELECT cpt_code FROM org_cpt_code_set
      WHERE org_id = ${session.orgId}::uuid AND active = TRUE
      ORDER BY cpt_code
    `;
    return rows.map((r) => r.cpt_code);
  });

  try {
    const rulebook = await generateRulebook({
      orgId: session.orgId,
      byUserId: session.userId,
      states: onb.activeStates,
      payerIds: onb.activePayerIds,
      cptCodes,
    });
    return ok({ rulebook });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Generation failed", {
      status: 422,
    });
  }
}
