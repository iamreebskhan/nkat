/**
 * GET  /api/admin/payers — the whole payer roster, inactive rows included,
 *                          with live rule counts per state.
 * POST /api/admin/payers — add a payer to the roster.
 *
 * Platform-admin only, the same gate as /api/admin/ingestion-sources. The
 * roster is global: a payer added here shows up in every org's pickers, so an
 * org admin must never reach this (audit R17).
 */
import { type NextRequest } from "next/server";

import { ok, fail, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  PayerInputSchema,
  createPayer,
  listPayersForAdmin,
} from "@/lib/features/billing/payer-admin.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  try {
    const rows = await listPayersForAdmin();
    return ok({ rows, total: rows.length });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  if (session.role !== "platform_admin") {
    return fail("Platform admin only.", { status: 403 });
  }
  const body = await parseJson(req, PayerInputSchema);
  if (body instanceof Response) return body;
  try {
    const row = await createPayer({ orgId: session.orgId, userId: session.userId, input: body });
    return ok(row, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
