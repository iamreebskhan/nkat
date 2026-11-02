/**
 * ICD-10 reference search — Phase C.1 (autocomplete from the static
 * icd10 reference table). Global reference data — the full CMS ICD-10-CM
 * release, db/seed/icd10cm-2027.sql, with its long descriptions; no RLS.
 *
 * CPT-ICD pairing is a v2 concern (the plan scoped v1 as "autocomplete
 * from a static ICD-10 table"); this returns active billable-aware
 * matches by code prefix or description.
 */
import { prisma } from "@/lib/db";

export interface Icd10Match {
  code: string;
  description: string;
  billable: boolean;
  chapter: string | null;
}

/** LIKE metacharacters in user input match themselves, not "anything". */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchIcd10(args: {
  query: string;
  limit?: number;
}): Promise<Icd10Match[]> {
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const q = args.query.trim();
  if (q.length < 2) return [];
  // A code typed with or without its dot: "I509" and "I50.9" both find I50.9.
  const codePrefix = `${likeLiteral(q.toUpperCase().replace(/\./g, ""))}%`;
  // Every word, in any order: "dementia unspecified" finds "Unspecified
  // dementia, unspecified severity, …". The whole phrase as one pattern
  // found nothing the moment the table held the full code set, whose
  // descriptions rarely put the words a clinician types side by side.
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6)
    .map((w) => `%${likeLiteral(w)}%`);
  const startsWith = `${likeLiteral(q.toLowerCase())}%`;
  const rows = await prisma.$queryRaw<
    { code: string; description: string; billable: boolean; chapter: string | null }[]
  >`
    SELECT code, description, billable, chapter
      FROM icd10
     WHERE expiration_date IS NULL
       AND (replace(UPPER(code), '.', '') LIKE ${codePrefix}
            OR lower(description) LIKE ALL (${words}::text[]))
     ORDER BY
       (replace(UPPER(code), '.', '') LIKE ${codePrefix}) DESC,  -- code matches first
       billable DESC,                                             -- billable before headers
       (lower(description) LIKE ${startsWith}) DESC,              -- "Heart failure, …" before "… with heart failure"
       length(description) ASC,                                   -- the general code before its refinements
       code ASC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    code: r.code,
    description: r.description,
    billable: r.billable,
    chapter: r.chapter,
  }));
}
