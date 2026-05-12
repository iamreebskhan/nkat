/** GET /api/documents — source document list + extraction stats. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  documentStats,
  listSourceDocuments,
} from "@/lib/features/documents/documents.service";

const Query = z.object({
  documentType: z.string().max(60).optional(),
  payerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const [rows, stats] = await Promise.all([
    listSourceDocuments(params),
    documentStats(),
  ]);
  return ok({ rows, stats });
}
