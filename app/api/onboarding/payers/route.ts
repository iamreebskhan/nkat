import { type NextRequest } from "next/server";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { savePayers } from "@/lib/features/onboarding/onboarding.service";
import { PayersSchema } from "@/lib/features/onboarding/onboarding.types";

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, PayersSchema);
  if (body instanceof Response) return body;
  try {
    const r = await savePayers({ orgId: session.orgId, payerIds: body.payerIds });
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Save failed", { status: 422 });
  }
}
