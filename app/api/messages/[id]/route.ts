/**
 * PATCH /api/messages/[id] — edit within the 5-minute window.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { editMessage } from "@/lib/features/messaging/messaging.service";

const Body = z.object({ body: z.string().min(1).max(5000) });

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["messaging.send"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    const r = await editMessage({
      orgId: session.orgId,
      id,
      userId: session.userId,
      newBody: body.body,
    });
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Edit failed.", { status: 422 });
  }
}
