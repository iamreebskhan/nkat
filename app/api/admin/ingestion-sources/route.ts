/**
 * POST /api/admin/ingestion-sources — register or upsert an ingestion
 *                                     source (CMS URL or payer policy URL).
 * GET  /api/admin/ingestion-sources — list configured sources.
 *
 * Platform-admin only. Each registered source is re-checked on its
 * configured cadence by the /api/cron/ingest-documents cron job.
 */
import { type NextRequest } from "next/server";

import { ok, fail, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  CreateSourceSchema,
  createSource,
  listSources,
} from "@/lib/features/ingestion/sources.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const rows = await listSources();
  return ok({ rows, total: rows.length });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const body = await parseJson(req, CreateSourceSchema);
  if (body instanceof Response) return body;
  try {
    const row = await createSource(body);
    return ok(row, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
