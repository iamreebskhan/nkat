/**
 * POST /api/reports/board/file — the month's board report as a file: the
 * workbook, the deck or the PDF, all built from one report. A POST because the
 * deck carries what the person typed for it. reports.export, as taking a report
 * out of Pallio is. Counts and money only, so it is not a PHI disclosure.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { boardDeck, boardFileName, boardHtml, boardWorkbook } from "@/lib/features/reports/board-files";
import { BoardFileSchema, type BoardFormat } from "@/lib/features/reports/board-report";
import { boardPdf, getBoardReport } from "@/lib/features/reports/board-report.service";

const MEDIA: Record<BoardFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["reports.export"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, BoardFileSchema);
  if (body instanceof Response) return body;
  try {
    const report = await getBoardReport({ orgId: session.orgId, month: body.month, celebrations: body.celebrations });
    const bytes = body.format === "xlsx" ? boardWorkbook(report) : body.format === "pptx" ? boardDeck(report) : await boardPdf(boardHtml(report));
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": MEDIA[body.format],
        "Content-Disposition": `attachment; filename="${boardFileName(report, body.format)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
