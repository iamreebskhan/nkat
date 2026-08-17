/**
 * Authenticated change-password — for users who know their current
 * password but want to rotate it. Separate from the forgot-password
 * flow which uses single-use tokens via email.
 *
 * Requires the current password to be re-verified; otherwise a stolen
 * session cookie could permanently lock the legitimate user out.
 */
import bcrypt from "bcryptjs";
import { checkPassword } from "@/lib/features/auth/password-policy";

import { prisma } from "@/lib/db";

const BCRYPT_ROUNDS = 12;

export type ChangePasswordResult =
  | { ok: true }
  | { error: "weak_password"; reason?: string }
  | { error: "current_wrong" }
  | { error: "user_missing" };

export async function changePassword(args: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<ChangePasswordResult> {
  // Same policy as signup — a rule that only guards the front door is not a
  // rule, since changing the password is the other way to choose one.
  const strength = checkPassword(args.newPassword);
  if (!strength.ok) return { error: "weak_password", reason: strength.reason };

  const rows = await prisma.$queryRaw<{ id: string; password_hash: string | null }[]>`
    SELECT id, password_hash FROM app_user WHERE id = ${args.userId}::uuid LIMIT 1
  `;
  const user = rows[0];
  if (!user || !user.password_hash) return { error: "user_missing" };

  const verified = await bcrypt.compare(args.currentPassword, user.password_hash);
  if (!verified) return { error: "current_wrong" };

  const newHash = await bcrypt.hash(args.newPassword, BCRYPT_ROUNDS);
  await prisma.$executeRaw`
    UPDATE app_user SET password_hash = ${newHash} WHERE id = ${args.userId}::uuid
  `;
  return { ok: true };
}
