/**
 * RFC 6238 Time-based One-Time Password (TOTP) — pure helper.
 *
 * No external dependencies; built on Node's crypto.createHmac.
 * Compatible with Google Authenticator, Authy, 1Password, Bitwarden.
 *
 *   - 6-digit code
 *   - 30-second step
 *   - HMAC-SHA1 (per RFC 6238 default)
 *   - ±1 step tolerance on verify (clock skew + user typing latency)
 *
 * The secret is the raw bytes; we expose helpers to encode/decode
 * base32 (the format authenticator apps expect via otpauth URIs).
 */
import { createHmac, randomBytes } from "crypto";

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const ALGO = "sha1";

/** Generate a fresh 20-byte (160-bit) shared secret. */
export function generateTotpSecret(): { rawBytes: Buffer; base32: string } {
  const rawBytes = randomBytes(20);
  return { rawBytes, base32: base32Encode(rawBytes) };
}

/** Generate the current 6-digit code for the given base32 secret. */
export function totpAtTime(base32Secret: string, now: Date = new Date()): string {
  const counter = Math.floor(now.getTime() / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

/**
 * Verify a user-supplied 6-digit code against the secret with ±1 step
 * tolerance. Returns true on first match (constant-time compare each
 * candidate so bench-timing won't reveal which step matched).
 */
export function verifyTotp(
  base32Secret: string,
  code: string,
  now: Date = new Date(),
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(base32Secret);
  const counter = Math.floor(now.getTime() / 1000 / PERIOD_SECONDS);
  let ok = false;
  for (const offset of [-1, 0, 1]) {
    const candidate = hotp(key, counter + offset);
    if (constantTimeEqual(candidate, code)) ok = true;
  }
  return ok;
}

/** Render an otpauth:// URI for QR-code scanning by authenticator apps. */
export function otpauthUri(args: {
  secretBase32: string;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = args.issuer ?? "Pallio";
  const label = encodeURIComponent(`${issuer}:${args.accountName}`);
  const params = new URLSearchParams({
    secret: args.secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// HOTP / Base32 internals
// ---------------------------------------------------------------------------

function hotp(key: Buffer, counter: number): string {
  // 8-byte big-endian counter
  const buf = Buffer.alloc(8);
  // Counter fits in JS safe integer for the next several centuries.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);

  const hmac = createHmac(ALGO, key).update(buf).digest();
  // Dynamic truncation per RFC 4226 §5.3
  const offset = hmac[hmac.length - 1]! & 0xf;
  const num =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (num % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export function base32Decode(s: string): Buffer {
  const stripped = s.replace(/=+$/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of stripped) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`base32Decode: invalid char "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
