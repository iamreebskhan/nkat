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

export async function GET(): Promise<Response> {
  const session = await requireAuth(["billing.lookup.view"]);
  if (session instanceof Response) return session;
  const payers = await listPayers();
  // Return both `payers` (semantic) and `rows` (consistent with every
  // other list endpoint) so consumers can pick either key.
  return ok({ payers, rows: payers });
}
