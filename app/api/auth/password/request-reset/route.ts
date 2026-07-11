/**
 * POST /api/auth/password/request-reset
 *
 * Always returns 200 — never reveals whether the email exists.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson } from "@/lib/api";
import { sendEmail } from "@/lib/email/email.service";
import { passwordResetEmail, passwordResetUrl } from "@/lib/email/templates-auth";
import { env } from "@/lib/env";
import { requestReset } from "@/lib/features/auth/password-reset.service";

const Body = z.object({
  email: z.string().email().max(254),
});

export async function POST(req: NextRequest): Promise<Response> {
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  const ip = readIp(req);
  const result = await requestReset({ email: body.email, ip });

  if (result.rawToken) {
    const tmpl = passwordResetEmail({
      to: result.email,
      resetUrl: passwordResetUrl(env().APP_BASE_URL, result.rawToken),
      branding: { displayName: null, primaryColor: null, logoUrl: null },
    });
    void sendEmail({
      to: result.email,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
    }).catch(() => undefined);
  }

  return ok({ sent: true });
}

function readIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? null;
}
