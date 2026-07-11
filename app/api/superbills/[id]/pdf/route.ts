/** GET /api/superbills/[id]/pdf — branded superbill PDF. */
import { type NextRequest } from "next/server";

import { handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { generateSuperbillPdf } from "@/lib/features/superbills/superbill-pdf.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.superbills.export"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const { pdfBytes } = await generateSuperbillPdf({
      orgId: session.orgId,
      userId: session.userId,
      superbillId: id,
    });
    return new Response(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="superbill-${id}.pdf"`,
      },
    });
  } catch (err) {
    return handleServiceError(err);
  }
}
