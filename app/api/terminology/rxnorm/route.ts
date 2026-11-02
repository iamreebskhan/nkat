/**
 * GET /api/terminology/rxnorm?q=&use=medication|allergy — RxNorm concepts for
 * what was typed into a medication or allergy field (0128). Only those words go
 * to NLM; nothing here knows which patient the chart is. An outage answers
 * unavailable, never an error: the chart saves free text all the same.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { searchRxnorm } from "@/lib/features/clinical/rxnorm.service";

const Query = z.object({
  q: z.string().trim().min(3, "Type at least three letters.").max(100),
  use: z.enum(["medication", "allergy"]).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  return ok(await searchRxnorm(params.q, params.use ?? "medication"));
}
