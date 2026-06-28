/**
 * ICD-10 reference search — Phase C.1 (autocomplete from the static
 * icd10 reference table). Global reference data (CMS public short
 * descriptions); no RLS.
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

export async function searchIcd10(args: {
  query: string;
  limit?: number;
}): Promise<Icd10Match[]> {
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const q = args.query.trim();
  if (q.length < 2) return [];
  const prefix = `${q.toUpperCase()}%`;
  const contains = `%${q.toLowerCase()}%`;
  const rows = await prisma.$queryRaw<
    { code: string; description: string; billable: boolean; chapter: string | null }[]
  >`
    SELECT code, description, billable, chapter
      FROM icd10
     WHERE expiration_date IS NULL
       AND (UPPER(code) LIKE ${prefix} OR lower(description) LIKE ${contains})
     ORDER BY
       (UPPER(code) LIKE ${prefix}) DESC,  -- code matches first
       billable DESC,                       -- billable codes before headers
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
