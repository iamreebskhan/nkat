/** Cheat sheet generation — POST returns the PDF directly + logs the row. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { generateCheatSheet } from "@/lib/features/cheatsheets/cheatsheet.service";
import { getBranding } from "@/lib/features/branding/branding.service";

const Body = z.object({
  state: z.string().length(2).regex(/^[A-Z]{2}$/).nullable().optional(),
  payerId: z.string().uuid().nullable().optional(),
  cptCodes: z.array(z.string().max(8)).max(80).optional(),
  orgName: z.string().min(1).max(120),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["cheatsheets.generate"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  try {
    const branding = await getBranding(session.orgId);
    const result = await generateCheatSheet({
      orgId: session.orgId,
      generatedByUserId: session.userId,
      state: body.state ?? null,
      payerId: body.payerId ?? null,
      cptCodes: body.cptCodes ?? [],
      orgName: branding.displayName ?? body.orgName,
      logoUrl: branding.logoUrl ?? undefined,
      primaryColor: branding.primaryColor ?? undefined,
    });
    return new Response(new Uint8Array(result.pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="cheatsheet-${result.id}.pdf"`,
        "X-Cheatsheet-Id": result.id,
        "X-Cheatsheet-Rows": String(result.rowCount),
      },
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Cheat sheet failed", { status: 500 });
  }
}
