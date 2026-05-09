/**
 * Code lookup with AMA-license gating (Prisma + Pallio).
 *
 * Ported from backend/src/codes/code.service.ts. The pure helper
 * `gateAmaDescriptors` lives in code-pure.ts and is reused verbatim;
 * this file only owns the DB I/O.
 */
import { type CodeRowFromDb, type CodeView, gateAmaDescriptors } from "./code-pure";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/** Has the operator wired the AMA license token? */
export function hasAmaLicense(): boolean {
  const token = env().AMA_LICENSE_TOKEN;
  return Boolean(token && token.trim().length > 0);
}

/** Look up a single code (CPT or HCPCS) by exact match. Returns null if absent. */
export async function lookupCode(code: string): Promise<CodeView | null> {
  const upper = code.toUpperCase();
  const rows = (await prisma.$queryRaw<CodeRowFromDb[]>`
    SELECT code, code_system, short_descriptor, category, effective_date, expiration_date
    FROM code
    WHERE code = ${upper}
    LIMIT 1
  `) ?? [];
  if (rows.length === 0) return null;
  const [view] = gateAmaDescriptors(rows, hasAmaLicense());
  return view;
}

/** Prefix search across active codes. Caps `limit` to [1, 50]. */
export async function searchCodes(args: {
  prefix?: string;
  system?: "CPT" | "HCPCS2";
  limit?: number;
}): Promise<CodeView[]> {
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const prefix = args.prefix ? args.prefix.toUpperCase() + "%" : null;

  // Hand-write SQL for two reasons:
  //   1. The `code` table isn't introspected into the Prisma schema yet
  //      (Phase 2 deliberately scopes to billing logic; the full
  //      `prisma db pull` lands later).
  //   2. The dynamic prefix + system filter is cleaner with a single
  //      parameterized query than a chained QueryBuilder.
  const rows = await prisma.$queryRawUnsafe<CodeRowFromDb[]>(
    `
    SELECT code, code_system, short_descriptor, category, effective_date, expiration_date
    FROM code
    WHERE expiration_date IS NULL
      ${prefix ? "AND code LIKE $1" : ""}
      ${args.system ? `AND code_system = $${prefix ? "2" : "1"}` : ""}
    ORDER BY code ASC
    LIMIT ${limit}
    `,
    ...([prefix, args.system].filter((v): v is string => v !== null && v !== undefined)),
  );

  return gateAmaDescriptors(rows, hasAmaLicense());
}
