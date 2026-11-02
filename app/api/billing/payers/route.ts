/**
 * GET /api/billing/payers
 *
 * Lists every payer configured in the global reference table. Used by
 * the rule-lookup form to populate the payer dropdown.
 *
 * Auth: requires `billing.lookup.view` (same as the lookup endpoint).
 */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

import { listPayers } from "@/lib/features/billing/payer-rule.repository";
import { getOrgPayerIds } from "@/lib/features/onboarding/onboarding.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["billing.lookup.view"]);
  if (session instanceof Response) return session;
  const payers = await listPayers();
  // The ones this practice picked at onboarding, so a list can offer them
  // first. Advisory: a patient's plan can be one the practice did not pick.
  const orgPayerIds = await getOrgPayerIds(session.orgId).catch(() => [] as string[]);
  // Return both `payers` (semantic) and `rows` (consistent with every
  // other list endpoint) so consumers can pick either key.
  return ok({ payers, rows: payers, orgPayerIds });
}
