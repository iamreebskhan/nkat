/**
 * POST /api/rulebook/save
 *
 * Apply org-admin edits to the rulebook. Each edit overwrites a cell's
 * coverage_status + rule_value and flips origin → 'org_override'.
 * Optional `finalize: true` marks the onboarding rulebook step complete.
 */
import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { markRulebookComplete } from "@/lib/features/onboarding/onboarding.service";
import { applyEdits } from "@/lib/features/rulebook/rulebook.service";
import { SaveRulebookSchema } from "@/lib/features/rulebook/rulebook.types";

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, SaveRulebookSchema);
  if (body instanceof Response) return body;

  try {
    const r = await applyEdits({
      orgId: session.orgId,
      edits: body.edits,
      byUserId: session.userId,
    });
    if (body.finalize) {
      await markRulebookComplete(session.orgId);
    }
    return ok({ updated: r.updated, finalized: Boolean(body.finalize) });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Save failed", {
      status: 422,
    });
  }
}
