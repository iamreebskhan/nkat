/**
 * Denials collection — GET (list, filterable) + POST (log).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listDenials,
  logDenial,
} from "@/lib/features/denials/denial.service";
import {
  DENIAL_DECISIONS,
  LogDenialSchema,
} from "@/lib/features/denials/denial.types";

const ListSchema = z.object({
  decision: z.enum(DENIAL_DECISIONS).optional(),
  superbillId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.denials.view"]);
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const params = parseSearchParams(url, ListSchema);
  if (params instanceof Response) return params;

  const rows = await listDenials({
    orgId: session.orgId,
    ...params,
  });
  return ok({ rows, total: rows.length });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.denials.log"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, LogDenialSchema);
  if (body instanceof Response) return body;

  try {
    const r = await logDenial({ orgId: session.orgId, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Log failed", {
      status: 422,
    });
  }
}
