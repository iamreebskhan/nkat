/**
 * GET /api/billing/code-bands — the CPT time ladders the suggester runs on.
 *
 * The document page computes suggested codes client-side so they update live as
 * the clinician adjusts start/stop. It therefore needs the ladders as data;
 * this is where it gets them, rather than the suggester carrying its own copy
 * that drifts from the rest of the product.
 *
 * Reference data, no PHI: no org scoping, no access log. Auth only, because
 * everything under /api requires a session.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVisitCodeBands } from "@/lib/features/visits/code-bands.service";

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;

  try {
    const bands = await getVisitCodeBands();
    return ok(bands);
  } catch (err) {
    return handleServiceError(err);
  }
}
