/**
 * POST /api/billing/lookup/pdf
 *
 * Renders a rule lookup result as a branded one-page PDF and streams
 * it back. Auth: requires `billing.lookup.export`.
 *
 * Body shape mirrors `/api/billing/lookup`'s response so the FE can
 * post the result it just received without re-querying.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { renderRuleAnswerPdf } from "@/lib/pdf/rule-answer";

const Schema = z.object({
  question: z.string().min(1).max(1000),
  answer: z.string().min(1),
  coverageStatus: z.enum(["covered", "not_covered", "varies", "unknown"]),
  confidence: z.number().min(0).max(1),
  source: z.enum(["structured_rule", "ai_synthesized", "unknown"]),
  citation: z
    .object({
      documentName: z.string(),
      documentUrl: z.string().nullable().optional(),
      effectiveDate: z.string().nullable().optional(),
      verbatimQuote: z.string(),
      page: z.number().nullable().optional(),
    })
    .nullable(),
  meta: z.object({
    payer: z.string().optional(),
    state: z.string().optional(),
    cptCode: z.string().optional(),
    orgName: z.string().optional(),
  }),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["billing.lookup.export"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Schema);
  if (body instanceof Response) return body;

  try {
    const pdf = await renderRuleAnswerPdf({
      ...body,
      meta: { ...body.meta, queriedAt: new Date() },
    });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="pallio-rule-${body.meta.cptCode ?? "lookup"}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
