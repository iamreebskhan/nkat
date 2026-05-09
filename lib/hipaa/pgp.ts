/**
 * pgcrypto helpers — read/write PHI columns through the
 * encrypt_phi() / decrypt_phi() Postgres functions.
 *
 * Source: pallio_complete_vision_v3 §15.1 (encrypted at rest).
 *
 * Pattern:
 *
 *   await withPhiKey(orgId, async (tx) => {
 *     await tx.$executeRaw`
 *       UPDATE patient
 *          SET primary_member_id_enc = encrypt_phi(${memberId})
 *        WHERE id = ${patientId}::uuid
 *     `;
 *
 *     const rows = await tx.$queryRaw<{ value: string }[]>`
 *       SELECT decrypt_phi(primary_member_id_enc) AS value
 *         FROM patient WHERE id = ${patientId}::uuid
 *     `;
 *   });
 *
 * The PHI key is rotated quarterly. Old ciphertexts must be re-encrypted
 * through a one-time migration before retiring the previous key.
 */
import { withOrgContext } from "@/lib/db";
import { env } from "@/lib/env";

export const PHI_KEY_ENV_VAR = "PALLIO_PHI_KEY";

function readPhiKey(): string {
  const key = process.env[PHI_KEY_ENV_VAR];
  if (!key || key.length < 32) {
    throw new Error(
      `${PHI_KEY_ENV_VAR} must be set to a key ≥32 chars before calling pgcrypto helpers. ` +
        `In dev, set it to any 32-char string; in prod, source from Vault.`,
    );
  }
  return key;
}

/**
 * Run a callback inside withOrgContext + with the app.phi_key GUC set.
 * Sets it via SET LOCAL so the key is scoped to the transaction —
 * never leaks across pooled connections.
 */
export async function withPhiKey<T>(
  orgId: string,
  fn: (tx: Parameters<Parameters<typeof withOrgContext<T>>[1]>[0]) => Promise<T>,
): Promise<T> {
  const key = readPhiKey();
  return withOrgContext(orgId, async (tx) => {
    // Single-quote the key with literal-escape so quotes inside it are safe.
    // Postgres SET LOCAL doesn't accept parameter binds, so we hand-escape.
    const escaped = key.replace(/'/g, "''");
    await tx.$executeRawUnsafe(`SET LOCAL app.phi_key = '${escaped}'`);
    return fn(tx);
  });
}

/** True iff the runtime is configured for pgcrypto (key present, valid length). */
export function isPgcryptoConfigured(): boolean {
  try {
    void env(); // ensures process env is loaded
    const key = process.env[PHI_KEY_ENV_VAR];
    return Boolean(key && key.length >= 32);
  } catch {
    return false;
  }
}
