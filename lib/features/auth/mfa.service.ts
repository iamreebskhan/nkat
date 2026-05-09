/**
 * MFA enrollment + verification.
 *
 * Flow:
 *   1. POST /api/auth/mfa/setup → server mints secret, stores it
 *      *unconfirmed* (mfa_enrolled_at NULL), returns base32 + otpauth URI.
 *   2. User adds to authenticator app, enters first code.
 *   3. POST /api/auth/mfa/verify { code } → on first valid code, server
 *      flips mfa_enrolled_at = now() and mints 10 recovery codes
 *      (returned exactly once).
 *
 * Login challenge:
 *   - login() (Phase 9) returns the session cookie *only* if the user
 *     has no MFA OR the supplied totpCode validates.
 *
 * Recovery codes are bcrypt-hashed at rest. Each redeem flips used_at
 * and returns true once.
 */
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

import { prisma } from "@/lib/db";
import {
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from "./totp";

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5; // → 10 hex chars

export interface SetupMfaResult {
  secretBase32: string;
  otpauthUri: string;
}

/** Mint + persist (unconfirmed) MFA secret for the user. */
export async function setupMfa(args: {
  userId: string;
  email: string;
}): Promise<SetupMfaResult> {
  const { rawBytes } = generateTotpSecret();
  const base32 = base32Encode(rawBytes);

  await prisma.$executeRaw`
    UPDATE app_user
       SET mfa_secret = ${base32},
           mfa_enrolled_at = NULL
     WHERE id = ${args.userId}::uuid
  `;

  return {
    secretBase32: base32,
    otpauthUri: otpauthUri({
      secretBase32: base32,
      accountName: args.email,
      issuer: "Pallio",
    }),
  };
}

export type VerifyMfaResult =
  | { confirmed: true; recoveryCodes: string[] }
  | { error: "no_pending_setup" }
  | { error: "bad_code" };

/**
 * Confirm enrollment by checking the user's first code. On success,
 * flips mfa_enrolled_at and mints 10 recovery codes. The plaintext
 * recovery codes are returned exactly once — caller MUST display them
 * to the user immediately.
 */
export async function confirmMfaSetup(args: {
  userId: string;
  code: string;
}): Promise<VerifyMfaResult> {
  const rows = await prisma.$queryRaw<
    { mfa_secret: string | null; mfa_enrolled_at: Date | null }[]
  >`
    SELECT mfa_secret, mfa_enrolled_at FROM app_user WHERE id = ${args.userId}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (!row || !row.mfa_secret) return { error: "no_pending_setup" };
  if (!verifyTotp(row.mfa_secret, args.code)) return { error: "bad_code" };

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(RECOVERY_CODE_BYTES).toString("hex"),
  );
  const hashes = await Promise.all(
    recoveryCodes.map((c) => bcrypt.hash(c, 10)),
  );

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE app_user SET mfa_enrolled_at = now() WHERE id = ${args.userId}::uuid
    `;
    // Replace any old recovery codes from a previous enrollment.
    await tx.$executeRaw`
      DELETE FROM mfa_recovery_code WHERE user_id = ${args.userId}::uuid
    `;
    for (const hash of hashes) {
      await tx.$executeRaw`
        INSERT INTO mfa_recovery_code (user_id, code_hash) VALUES (${args.userId}::uuid, ${hash})
      `;
    }
  });

  return { confirmed: true, recoveryCodes };
}

/**
 * Login-time challenge: returns true if either the TOTP code is valid
 * OR an unused recovery code matches (and is then marked used).
 */
export async function verifyMfaChallenge(args: {
  userId: string;
  code: string;
}): Promise<boolean> {
  const rows = await prisma.$queryRaw<
    { mfa_secret: string | null; mfa_enrolled_at: Date | null }[]
  >`
    SELECT mfa_secret, mfa_enrolled_at FROM app_user WHERE id = ${args.userId}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (!row?.mfa_secret || !row.mfa_enrolled_at) return false;

  // Try TOTP first.
  if (/^\d{6}$/.test(args.code) && verifyTotp(row.mfa_secret, args.code)) {
    return true;
  }

  // Fall back to recovery code (10 hex chars).
  if (!/^[0-9a-f]{10}$/i.test(args.code)) return false;
  const candidates = await prisma.$queryRaw<{ id: string; code_hash: string }[]>`
    SELECT id, code_hash FROM mfa_recovery_code
    WHERE user_id = ${args.userId}::uuid AND used_at IS NULL
  `;
  for (const c of candidates) {
    if (await bcrypt.compare(args.code.toLowerCase(), c.code_hash)) {
      await prisma.$executeRaw`
        UPDATE mfa_recovery_code SET used_at = now() WHERE id = ${c.id}::uuid
      `;
      return true;
    }
  }
  return false;
}

/** Disable MFA — wipes secret + recovery codes. */
export async function disableMfa(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE app_user SET mfa_secret = NULL, mfa_enrolled_at = NULL WHERE id = ${userId}::uuid
    `;
    await tx.$executeRaw`
      DELETE FROM mfa_recovery_code WHERE user_id = ${userId}::uuid
    `;
  });
}

export async function isMfaEnrolled(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ mfa_enrolled_at: Date | null }[]>`
    SELECT mfa_enrolled_at FROM app_user WHERE id = ${userId}::uuid LIMIT 1
  `;
  return Boolean(rows[0]?.mfa_enrolled_at);
}
