/**
 * /api/integrations/clearinghouses — the practice's clearinghouse connections
 * (0120): list them, add one.
 *
 * settings.integrations (org admins): a connection holds the IDs every claim
 * carries and the passwords that reach the clearinghouse. Secrets go in once
 * and never come back out; a view says only which are saved.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJsonAs } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { ConnectionInputSchema } from "@/lib/features/clearinghouse/connection-settings";
import { createConnection, listConnections } from "@/lib/features/clearinghouse/connection.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  try {
    return ok({ connections: await listConnections({ orgId: session.orgId }) });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.integrations"]);
  if (session instanceof Response) return session;
  const body = await parseJsonAs(req, ConnectionInputSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await createConnection({ orgId: session.orgId, userId: session.userId, input: body }), { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
