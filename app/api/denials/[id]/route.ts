/** GET single denial (with AI analysis if recorded). */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getDenial } from "@/lib/features/denials/denial.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.denials.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const denial = await getDenial({ orgId: session.orgId, id });
  if (!denial) return fail("Denial not found.", { status: 404 });
  return ok(denial);
}
