/**
 * Loads what a visit's note documents and what its payer requires, and runs
 * the pure check in documentation-check.ts (audit R19).
 *
 * Runs inside the caller's transaction, so the reconciliation, the risk score
 * and the submit gate all read the same state they are about to act on.
 * Reads two global reference tables (documentation_requirement, payer)
 * alongside the RLS-scoped visit, patient and bill.
 *
 * No payer, no codes, or no requirement on file returns no results: the risk
 * scorer already flags a claim with no payer, and a payer with no structured
 * standard stays advisory until an analyst attests one.
 */
import type { Prisma } from "@prisma/client";

import { dateColumnIso, orgLocalDate } from "@/lib/features/org/org-date";

import { checkDocumentation, type CodeDocumentation } from "./documentation-check";
import { noteIsEmpty } from "./visit-pure";

type Tx = Pick<Prisma.TransactionClient, "$queryRaw">;

export interface DocumentationGaps {
  payerName: string | null;
  results: CodeDocumentation[];
}

interface FactsRow {
  is_telehealth: boolean | null;
  telehealth_modality: string | null;
  total_minutes: number | null;
  dx_count: number | null;
  /** The bill's date of service (a DATE); NULL on a visit not billed yet. */
  dos: Date | null;
  /** The visit branch only: its start, and the org's zone to read it in. */
  visit_at?: Date | null;
  org_timezone?: string | null;
  state: string | null;
  payer_id: string | null;
  payer_name: string | null;
  codes: string[] | null;
  filled_keys: string[] | null;
  template_keys: string[] | null;
  has_vitals: boolean | null;
  /** The pre-0088 single free-text note, if the visit has one. */
  document_text: string | null;
}

/**
 * `{ visitId }` reads the visit as it stands, before or after signing: the
 * payer, codes and date of service are the latest bill's, or before a bill
 * exists the patient's primary payer, the visit's codes and `dos` if given,
 * else the day the visit started where the practice is (0107). `{ superbillId }`
 * reads the claim about to go out: its own payer, codes and date of service.
 * `codes` overrides the codes checked, for a risk preview of codes not yet
 * saved; `dos` ('YYYY-MM-DD') is the date of service being scored.
 */
export async function loadDocumentationGaps(
  tx: Tx,
  target: { visitId: string } | { superbillId: string },
  opts: { codes?: readonly string[]; dos?: string } = {},
): Promise<DocumentationGaps> {
  const rows =
    "visitId" in target
      ? await tx.$queryRaw<FactsRow[]>`
          SELECT dv.is_telehealth, dv.telehealth_modality, dv.total_minutes, dv.document_text,
                 cardinality(COALESCE(dv.icd10_codes, ARRAY[]::text[]))::int AS dx_count,
                 -- The bill's date of service once billed, the one the payer
                 -- holds; before that the visit's start, turned into the org's
                 -- day below. A ::date cast here was the database session's
                 -- day, which is not the practice's.
                 lb.date_of_service AS dos,
                 COALESCE(dv.start_time, dv.scheduled_start) AS visit_at,
                 o.timezone AS org_timezone,
                 COALESCE(dp.insurance_state, dp.state)::text AS state,
                 COALESCE(lb.payer_id, dp.primary_payer_id) AS payer_id,
                 py.name AS payer_name,
                 COALESCE(lb.cpt_codes, dv.cpt_codes_assigned) AS codes,
                 ARRAY(SELECT ns.section_key FROM visit_note_section ns
                        WHERE ns.visit_id = dv.id AND NOT COALESCE(ns.is_empty, TRUE)) AS filled_keys,
                 -- The visit's pinned template, else the org's active one:
                 -- the same fallback as the sign guard and the packet loader.
                 ARRAY(SELECT ts.section_key FROM note_template_section ts
                        WHERE ts.template_id = COALESCE(dv.note_template_id,
                                (SELECT nt.id FROM note_template nt
                                  WHERE nt.org_id = dv.org_id AND nt.is_active LIMIT 1))) AS template_keys,
                 EXISTS (SELECT 1 FROM visit_vitals vv
                          WHERE vv.visit_id = dv.id
                            AND num_nonnulls(vv.weight_kg, vv.height_cm, vv.bp_systolic, vv.bp_diastolic,
                                             vv.heart_rate, vv.resp_rate, vv.temperature_c, vv.spo2_percent,
                                             vv.pps_percent, vv.pain_score) > 0) AS has_vitals
            FROM visit dv
            JOIN patient dp ON dp.id = dv.patient_id
            JOIN org o ON o.id = dv.org_id
            LEFT JOIN LATERAL (
              SELECT s.payer_id, s.cpt_codes, s.date_of_service FROM superbill s
               WHERE s.visit_id = dv.id
               ORDER BY s.created_at DESC LIMIT 1
            ) lb ON TRUE
            LEFT JOIN payer py ON py.id = COALESCE(lb.payer_id, dp.primary_payer_id)
           WHERE dv.id = ${target.visitId}::uuid
           LIMIT 1
        `
      : await tx.$queryRaw<FactsRow[]>`
          SELECT dv.is_telehealth, dv.telehealth_modality, dv.total_minutes, dv.document_text,
                 cardinality(COALESCE(dv.icd10_codes, ARRAY[]::text[]))::int AS dx_count,
                 sb.date_of_service AS dos,
                 COALESCE(dp.insurance_state, dp.state)::text AS state,
                 sb.payer_id,
                 py.name AS payer_name,
                 sb.cpt_codes AS codes,
                 ARRAY(SELECT ns.section_key FROM visit_note_section ns
                        WHERE ns.visit_id = dv.id AND NOT COALESCE(ns.is_empty, TRUE)) AS filled_keys,
                 ARRAY(SELECT ts.section_key FROM note_template_section ts
                        WHERE ts.template_id = COALESCE(dv.note_template_id,
                                (SELECT nt.id FROM note_template nt
                                  WHERE nt.org_id = dv.org_id AND nt.is_active LIMIT 1))) AS template_keys,
                 EXISTS (SELECT 1 FROM visit_vitals vv
                          WHERE vv.visit_id = dv.id
                            AND num_nonnulls(vv.weight_kg, vv.height_cm, vv.bp_systolic, vv.bp_diastolic,
                                             vv.heart_rate, vv.resp_rate, vv.temperature_c, vv.spo2_percent,
                                             vv.pps_percent, vv.pain_score) > 0) AS has_vitals
            FROM superbill sb
            JOIN visit dv ON dv.id = sb.visit_id
            JOIN patient dp ON dp.id = sb.patient_id
            LEFT JOIN payer py ON py.id = sb.payer_id
           WHERE sb.id = ${target.superbillId}::uuid
           LIMIT 1
        `;

  const f = rows[0];
  const none: DocumentationGaps = { payerName: f?.payer_name ?? null, results: [] };
  // A billed visit is checked on its bill's date, as the claim itself is; an
  // unbilled one on the date being scored, else on the org-local day of its
  // start. The bill's is a DATE, the visit's an instant.
  const dos = f?.dos
    ? dateColumnIso(new Date(f.dos))
    : (opts.dos ??
      (f?.visit_at && f.org_timezone ? orgLocalDate(f.visit_at, f.org_timezone) : null));
  if (!f || !f.payer_id || !f.state || !dos) return none;
  const codes = [...new Set((opts.codes ?? f.codes ?? []).map((c) => c.toUpperCase()))];
  if (codes.length === 0) return none;

  const reqs = await tx.$queryRaw<{ code: string; required_chart_elements: string[] | null }[]>`
    SELECT code, required_chart_elements
      FROM documentation_requirement
     WHERE code = ANY(${codes}::text[])
       AND (payer_id = ${f.payer_id}::uuid OR payer_id IS NULL)
       AND (state = ${f.state} OR state IS NULL)
       AND effective_date <= ${dos}::date
       AND (expiration_date IS NULL OR expiration_date > ${dos}::date)
       AND cardinality(required_chart_elements) > 0
  `;
  if (reqs.length === 0) return none;

  return {
    payerName: f.payer_name,
    results: checkDocumentation(
      reqs.map((r) => ({ code: r.code, elements: r.required_chart_elements ?? [] })),
      {
        filledSections: f.filled_keys ?? [],
        templateSections: f.template_keys ?? [],
        hasVitals: Boolean(f.has_vitals),
        dxCount: Number(f.dx_count ?? 0),
        isTelehealth: Boolean(f.is_telehealth),
        telehealthModality: f.telehealth_modality,
        totalMinutes: f.total_minutes,
        // The same rule as the sign guard: no section filled, but the legacy
        // free-text column holds the note.
        legacyNote: (f.filled_keys ?? []).length === 0 && !noteIsEmpty(f.document_text),
      },
    ),
  };
}
