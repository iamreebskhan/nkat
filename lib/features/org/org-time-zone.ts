/**
 * The practice's time zone, read inside the caller's transaction (0107).
 *
 * org.timezone is NOT NULL with a default, so every org row has one. RLS on
 * org lets withOrgContext read its own row only.
 */
import type { Prisma } from "@prisma/client";

import { NotFoundError } from "@/lib/api";

type Tx = Pick<Prisma.TransactionClient, "$queryRaw">;

export async function readOrgTimeZone(tx: Tx, orgId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT timezone FROM org WHERE id = ${orgId}::uuid LIMIT 1
  `;
  const zone = rows[0]?.timezone;
  if (!zone) throw new NotFoundError("Organization not found.");
  return zone;
}
