/**
 * GET  /api/patients/[id]/messages — read the patient's thread.
 * POST /api/patients/[id]/messages — append a message (auto-creates
 *                                    the thread on first call).
 *
 * Phase F (nurses-only). PHI: every read writes a phi_access_log row.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listMessages,
  postMessage,
} from "@/lib/features/messaging/messaging.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

const PostBody = z.object({ body: z.string().min(1).max(5000) });

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["messaging.read"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  try {
    const result = await listMessages({
      orgId: session.orgId,
      patientId: id,
      userId: session.userId,
    });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "view",
      context: "patient_thread",
      request: req,
    });
    return ok(result);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed.", { status: 422 });
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["messaging.send"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const body = await parseJson(req, PostBody);
  if (body instanceof Response) return body;
  try {
    const message = await postMessage({
      orgId: session.orgId,
      patientId: id,
      userId: session.userId,
      body: body.body,
    });
    return ok(message, { status: 201 });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Post failed.", { status: 422 });
  }
}
