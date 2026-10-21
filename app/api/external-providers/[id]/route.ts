/**
 * PATCH /api/external-providers/[id] — correct a roster entry (audit R30):
 * a phone, fax, specialty or NPI fixed once, for every patient that links
 * this provider. No new permission: whoever may edit a chart may do this.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { updateOrgProvider } from "@/lib/features/patients/external-providers.service";
import { UpdateExternalProviderSchema } from "@/lib/features/patients/contacts.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, UpdateExternalProviderSchema);
  if (body instanceof Response) return body;
  try {
    return ok(
      await updateOrgProvider({
        orgId: session.orgId,
        userId: session.userId,
        providerId: id,
        patch: body,
      }),
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
