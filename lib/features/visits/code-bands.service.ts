/**
 * Build the CPT time ladders from `code.typical_minutes`.
 *
 * This is the single source the suggester reads. It used to hold its own copy
 * of the ladder as constants, and that copy had drifted from the code
 * descriptors, the AI parser prompt and the gold-standard eval — all three of
 * which agree on 15/30/60/75 and 20/30/40/60. Seven of the suggester's eight
 * bands fired early, always toward the higher-paying code.
 *
 * The `code` table is global reference data, not tenant data, so this needs no
 * org context and the result is identical for every org.
 */
import { prisma } from "@/lib/db";

import {
  buildBands,
  ESTABLISHED_PATIENT_HOME_CODES,
  NEW_PATIENT_HOME_CODES,
  type CodeTime,
  type VisitCodeBands,
} from "./cpt-suggester";

/**
 * Codes are versioned by effective_date, so a code can have more than one row.
 * Take the row in force today: the latest effective_date that has started and
 * has not expired.
 */
export async function getVisitCodeBands(): Promise<VisitCodeBands> {
  const wanted = [...NEW_PATIENT_HOME_CODES, ...ESTABLISHED_PATIENT_HOME_CODES];

  const rows = await prisma.$queryRaw<{ code: string; typical_minutes: number | null }[]>`
    SELECT DISTINCT ON (c.code) c.code, c.typical_minutes
      FROM code c
     WHERE c.code = ANY(${wanted}::text[])
       AND c.effective_date <= CURRENT_DATE
       AND (c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE)
     ORDER BY c.code, c.effective_date DESC
  `;

  const times = new Map(rows.map((r) => [r.code, r.typical_minutes]));
  const pick = (codes: readonly string[]): CodeTime[] =>
    codes
      .map((code) => ({ code, typicalMinutes: times.get(code) ?? null }))
      .filter((t): t is CodeTime => t.typicalMinutes !== null);

  return {
    newPatientHome: buildBands(pick(NEW_PATIENT_HOME_CODES)),
    establishedPatientHome: buildBands(pick(ESTABLISHED_PATIENT_HOME_CODES)),
  };
}
