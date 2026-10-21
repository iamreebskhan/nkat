/**
 * A patient's outside providers (audit R30) — GET (list) + POST (link).
 *
 * The PCP, the referring physician and the specialists that head Mark's note.
 * POST links a provider already on the org's roster, or describes a new one,
 * which joins the roster (or matches the roster row holding its NPI).
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  linkPatientProvider,
  listPatientProviders,
} from "@/lib/features/patients/external-providers.service";
import { LinkExternalProviderSchema } from "@/lib/features/patients/contacts.types";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const rows = await listPatientProviders({ orgId: session.orgId, patientId: id });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "view",
      context: "patient_providers",
      request: req,
    });
    return ok({ rows });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, LinkExternalProviderSchema);
  if (body instanceof Response) return body;
  try {
    const r = await linkPatientProvider({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      input: body,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "edit",
      context: "patient_providers",
      request: req,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
