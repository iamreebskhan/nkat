/**
 * GET /api/rulebook/comparison?uploadId=… — Path B side-by-side
 * (§9.4.2): the org's uploaded rows vs the Pallio source library.
 */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { buildComparison } from "@/lib/features/rulebook/rulebook.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.view"]);
  if (session instanceof Response) return session;

  const uploadId = new URL(req.url).searchParams.get("uploadId");
  if (!uploadId) return fail("uploadId is required.", { status: 400 });

  try {
    const rows = await buildComparison({ orgId: session.orgId, uploadId });
    const summary = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    }, {});
    return ok({ rows, total: rows.length, summary });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Comparison failed", {
      status: 422,
    });
  }
}
