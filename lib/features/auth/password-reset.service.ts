/**
 * Forgot-password flow.
 *
 *   1. requestReset(email): if the email exists, mint a 32-byte URL-safe
 *      token. Store sha256(token) in password_reset_token. Email the
 *      user a link with the raw token. Always return ok — never reveal
 *      whether the email exists.
 *   2. confirmReset(token, newPassword): hash + match in DB, swap
 *      password_hash, mark token redeemed.
 *
 * Security notes:
 *   - Token = 32 random bytes, hex-encoded → 64 chars in the URL.
 *   - We hash before storing so a DB leak doesn't grant resets.
 *   - 30-minute expiry. The trigger expires older tokens on every insert.
 *   - Constant-time response on the request endpoint to avoid email
 *     enumeration.
 *   - Each redeem is single-use; redeeming flips redeemed_at.
 *   - Caller is responsible for the email send (kept separate so the
 *     service is unit-testable).
 */
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";

import { prisma } from "@/lib/db";

const TOKEN_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

export interface RequestResetInput {
  email: string;
  ip?: string | null;
}

export interface RequestResetResult {
  /**
   * The raw URL token. The caller emails the user a link containing it.
   * NULL when the email is unknown — caller MUST send a generic
   * "if the email exists, you'll get a link" response either way to
   * avoid enumeration leaks.
   */
  rawToken: string | null;
  email: string;
}

export async function requestReset(input: RequestResetInput): Promise<RequestResetResult> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM app_user WHERE email = ${input.email}::citext AND status = 'active' LIMIT 1
  `;
  const user = rows[0];
  if (!user) {
    return { rawToken: null, email: input.email };
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);

  await prisma.$executeRaw`
    INSERT INTO password_reset_token (user_id, token_hash, expires_at, ip_requested)
    VALUES (${user.id}::uuid, ${tokenHash}::bytea, ${expiresAt}::timestamptz, ${input.ip ?? null}::inet)
  `;

  return { rawToken, email: input.email };
}

export interface ConfirmResetInput {
  rawToken: string;
  newPassword: string;
  ip?: string | null;
}

export type ConfirmResetResult =
  | { userId: string; email: string }
  | { error: "expired_or_invalid" }
  | { error: "weak_password" };

export async function confirmReset(input: ConfirmResetInput): Promise<ConfirmResetResult> {
  if (input.newPassword.length < 12) return { error: "weak_password" };

  const tokenHash = sha256(input.rawToken);

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        user_id: string;
        email: string;
        expires_at: Date;
        redeemed_at: Date | null;
      }[]
    >`
      SELECT t.id, t.user_id, u.email, t.expires_at, t.redeemed_at
      FROM password_reset_token t
      JOIN app_user u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}::bytea
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.redeemed_at || row.expires_at.getTime() < Date.now()) {
      return { error: "expired_or_invalid" } as const;
    }

    const newHash = await bcrypt.hash(input.newPassword, 12);

    await tx.$executeRaw`
      UPDATE app_user
         SET password_hash = ${newHash}
       WHERE id = ${row.user_id}::uuid
    `;
    await tx.$executeRaw`
      UPDATE password_reset_token
         SET redeemed_at = now(),
             ip_redeemed = ${input.ip ?? null}::inet
       WHERE id = ${row.id}::uuid
    `;

    return { userId: row.user_id, email: row.email };
  });
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}
