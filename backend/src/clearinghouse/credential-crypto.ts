/**
 * AES-256-GCM credential encryption.
 *
 * Pure helpers — no DB, no DI. The caller (CredentialService) supplies
 * the master key + version. Tests use a fixed key + IV; production
 * pulls from Secrets Manager.
 *
 *   encrypt({ master, plaintext }) → { ciphertext, iv, auth_tag }
 *   decrypt({ master, payload })   → plaintext
 *
 * GCM provides confidentiality + integrity in one pass; the auth_tag
 * is verified before decrypt returns. Tampered ciphertext throws.
 *
 * IV: 12 bytes from crypto.randomBytes(). Never reused for the same key.
 * Tag: 16 bytes (GCM standard).
 *
 * The "key version" lets us rotate the master key without rewriting
 * every row at once: rows store key_version, the decrypt path looks up
 * the right master from a small in-memory map, and a background re-
 * encrypt task can sweep old-version rows lazily.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: string;   // base64
  iv: string;           // base64 (12 bytes)
  auth_tag: string;     // base64 (16 bytes)
}

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32; // 256 bits

/**
 * Validates a master key — must be exactly 32 bytes after base64 decode.
 * Throws (sync) if invalid; the caller treats this as a startup error.
 */
export function parseMasterKey(b64: string): Buffer {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error('master key is empty');
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `master key must be ${KEY_LEN} bytes (got ${buf.length}); generate one with: ` +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return buf;
}

export function encrypt(args: { master: Buffer; plaintext: string }): EncryptedPayload {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, args.master, iv);
  const ct = Buffer.concat([cipher.update(args.plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: tag.toString('base64'),
  };
}

export function decrypt(args: { master: Buffer; payload: EncryptedPayload }): string {
  const iv = Buffer.from(args.payload.iv, 'base64');
  const tag = Buffer.from(args.payload.auth_tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error(`bad IV length: ${iv.length}`);
  if (tag.length !== 16) throw new Error(`bad auth tag length: ${tag.length}`);
  const decipher = createDecipheriv(ALG, args.master, iv);
  decipher.setAuthTag(tag);
  const ct = Buffer.from(args.payload.ciphertext, 'base64');
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Compute a stable display suffix for a credential payload — last 4
 * characters of the most-identifying field. Pure, never reveals more
 * than 4 chars.
 */
export function displaySuffix(payload: Record<string, unknown>): string {
  // Pick the first available identifier-ish field.
  const candidates = ['client_id', 'clientId', 'username', 'trader_id', 'traderId'];
  for (const k of candidates) {
    const v = payload[k];
    if (typeof v === 'string' && v.length > 0) {
      return v.slice(-4).padStart(4, '*');
    }
  }
  return '****';
}
