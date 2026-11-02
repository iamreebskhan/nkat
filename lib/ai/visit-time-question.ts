/**
 * A rule lookup that states a home visit's time is answered with the code that
 * visit bills — worked out by the CPT suggester, not left to the parser.
 *
 * The parser prompt carries the rule (G0318 starts at 140 minutes on a new
 * patient's 99345 and at 110 on an established patient's 99350), and Haiku
 * still answered "145 minutes of home visit time, new patient, Medicare" with
 * 99345: the gold-standard eval's cp-07, and the same answer on production on
 * 2026-10-22. The arithmetic belongs to the suggester, which the visit screen
 * already uses to code that exact visit, so a question shaped like a visit is
 * answered by it. The convention is the canon's (gold-standard-canon.spec.ts):
 * the prolonged add-on when the visit carries one, else the base code.
 *
 * Pure, and no database: the parser-only eval runs without one. The ladders
 * are the CPT descriptor times db/seed/0007_palliative_codes.sql stores and
 * the parser prompt states.
 */
import {
  buildBands,
  suggestCodes,
  type VisitCodeBands,
} from "@/lib/features/visits/cpt-suggester";

const BANDS: VisitCodeBands = {
  newPatientHome: buildBands([
    { code: "99341", typicalMinutes: 15 },
    { code: "99342", typicalMinutes: 30 },
    { code: "99344", typicalMinutes: 60 },
    { code: "99345", typicalMinutes: 75 },
  ]),
  establishedPatientHome: buildBands([
    { code: "99347", typicalMinutes: 20 },
    { code: "99348", typicalMinutes: 30 },
    { code: "99349", typicalMinutes: 40 },
    { code: "99350", typicalMinutes: 60 },
  ]),
};

const MINUTES = /\b(\d{1,3})\s*-?\s*(?:minutes|minute|mins|min)\b/gi;

/**
 * The code a home visit described by its time bills, or null when the
 * question is not one: no single minute figure, no home visit, not new or
 * established, or about something the time does not decide on its own
 * (advance care planning, telehealth).
 */
export function visitTimeQuestionCode(query: string, payer: string | null): string | null {
  const q = query.toLowerCase();
  if (/\b(acp|advance care planning|tele-?health|video|audio)\b/.test(q)) return null;
  if (!/\b(home|residence)\b/.test(q)) return null;
  const visitType = /\bnew[\s-]+patient\b/.test(q)
    ? "new_patient_home"
    : /\bestablished\b/.test(q)
      ? "established_patient_home"
      : null;
  if (!visitType) return null;
  const minutes = [...q.matchAll(MINUTES)].map((m) => Number(m[1]));
  // One time, and no other figure that could be one: "60 or 75 minutes" names
  // two. Codes are five characters, so they are not counted.
  const figures = q.match(/\b\d{1,3}\b/g) ?? [];
  if (minutes.length !== 1 || figures.length !== 1) return null;
  const totalMinutes = minutes[0]!;
  if (!(totalMinutes > 0 && totalMinutes <= 600)) return null;
  const medicare = /\bmedicare\b/i.test(`${payer ?? ""} ${q}`);
  const s = suggestCodes({
    bands: BANDS,
    visitType,
    totalMinutes,
    acpMinutes: 0,
    payerCategory: medicare ? "medicare" : "non_medicare",
  });
  return s.prolongedAddOns[0]?.code ?? s.base[0]?.code ?? null;
}
