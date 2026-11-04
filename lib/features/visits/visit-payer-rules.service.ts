/**
 * The payer's rules for codes on a visit, as they stood on its date of service.
 *
 * What the documentation screen's "Payer rules" panel shows (vision §5.2: rules
 * at the point of documentation). The panel asked POST /api/billing/lookup,
 * which needs billing.lookup.view, a permission the clinician role leaves out
 * (lib/features/team/team.types.ts), so every clinician's lookup was refused.
 * The answers are the same lookup: org rulebook first, then the global library,
 * then the benchmark. The payer, the coverage state and the date of service are
 * read from the visit and its patient, never taken from the caller, so a caller
 * who may open the visit learns its payer's rules and nothing beyond them.
 */
import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import type { PayerRuleAttribute } from "@/lib/features/billing/payer-rule.repository";
import { lookupRule, type LookupResult } from "@/lib/features/billing/rule-lookup.service";
import { persistSynthesizedRule } from "@/lib/features/billing/synthesized-rule.service";
import { DEFAULT_ORG_TIME_ZONE, orgLocalDate } from "@/lib/features/org/org-date";

export interface VisitPayerRules {
  /** The visit's date of service where the practice is (0107): the rules of that day answered. */
  dos: string;
  /** One answer per code. Empty when the patient has no payer or coverage state on file. */
  results: Record<string, LookupResult>;
}

export async function getVisitPayerRules(args: {
  orgId: string;
  visitId: string;
  codes: string[];
  attribute: PayerRuleAttribute;
}): Promise<VisitPayerRules> {
  const rows = await withOrgContext(args.orgId, (tx) =>
    tx.$queryRaw<
      { payer_id: string | null; state: string | null; at: Date | null; org_timezone: string | null }[]
    >`
      SELECT p.primary_payer_id AS payer_id,
             COALESCE(p.insurance_state, p.state) AS state,
             COALESCE(v.start_time, v.scheduled_start) AS at,
             o.timezone AS org_timezone
        FROM visit v
        -- The visit's own org's patient: the FK is id-only.
        JOIN patient p ON p.id = v.patient_id AND p.org_id = v.org_id
        JOIN org o ON o.id = v.org_id
       WHERE v.id = ${args.visitId}::uuid
         AND v.org_id = ${args.orgId}::uuid
       LIMIT 1
    `,
  );
  const r = rows[0];
  if (!r) throw new NotFoundError("Visit not found.");

  // The day the visit started where the practice is, as its bill is dated
  // (buildDraftFromVisit): the rules in force then, not on the day the note is
  // finished.
  const dos = orgLocalDate(r.at ?? new Date(), r.org_timezone ?? DEFAULT_ORG_TIME_ZONE);
  const results: Record<string, LookupResult> = {};
  if (!r.payer_id || !r.state) return { dos, results };

  // In turn, not at once: each lookup can call the model.
  for (const code of new Set(args.codes)) {
    const result = await lookupRule({
      payerId: r.payer_id,
      state: r.state,
      cptCode: code,
      attribute: args.attribute,
      dos,
      orgId: args.orgId,
    });
    if (result.status === "ok" && result.source === "ai_synthesized") {
      await persistSynthesizedRule(result, args.orgId).catch((e) => {
        console.warn("ai_synthesized persist failed (non-fatal):", e);
      });
    }
    results[code] = result;
  }
  return { dos, results };
}
