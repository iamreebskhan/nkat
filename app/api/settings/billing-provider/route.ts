/**
 * Who the practice's claims bill as (0118; Level-1 doc:67). See
 * billing-provider.service.ts.
 *
 *   GET — the billing provider and what a claim still needs (settings.view)
 *   PUT — save it (settings.org)
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  BillingProviderSchema,
  getBillingProvider,
  updateBillingProvider,
} from "@/lib/features/billing/billing-provider.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await getBillingProvider(session.orgId));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, BillingProviderSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updateBillingProvider({ orgId: session.orgId, userId: session.userId, payload: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
