/** POST /api/auth/password/confirm-reset { token, newPassword } */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { confirmReset } from "@/lib/features/auth/password-reset.service";

const Body = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, "Bad token format"),
  newPassword: z.string().min(12).max(200),
});

export async function POST(req: NextRequest): Promise<Response> {
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const r = await confirmReset({ rawToken: body.token, newPassword: body.newPassword, ip });
  if ("error" in r) {
    if (r.error === "weak_password") {
      return fail("Password must be at least 12 characters.", { status: 422 });
    }
    return fail("Reset link expired or invalid.", { status: 410 });
  }
  return ok({ email: r.email });
}
