/**
 * The offline copy, encrypted on the device (0121; security roadmap Phase 0;
 * ONC 170.315(d)(7) end-user device encryption).
 *
 * The copy of a clinician's caseload and the notes written with no signal sat
 * in the browser's storage as plain text, protected only by the iPad's own
 * passcode. Now every record is sealed with AES-GCM under one random data key
 * for the device, and that key is itself kept twice, wrapped:
 *
 *   - by the PIN the clinician sets (PBKDF2-SHA-256, 600,000 rounds), which is
 *     what opens the copy in a home with no signal;
 *   - by a key the server derives for this clinician (GET /api/offline/key,
 *     signed-in only), which opens it whenever they are signed in, so notes
 *     written offline are never lost to a forgotten PIN.
 *
 * Five wrong PINs drop the PIN's wrapping: the copy can then be opened only by
 * signing in, where a new PIN can be set. Nothing readable is kept at rest.
 *
 * Pure: Web Crypto only, so it runs the same in the browser and in tests.
 */

/** Ciphertext and its nonce, base64. */
export interface Box {
  iv: string;
  ct: string;
}

export interface VaultRecord {
  v: 2;
  /** Whose copy: checked against the session before anything is opened. */
  userId: string;
  orgId: string;
  /** The org's idle limit when saved: the offline page locks after it too. */
  idleMinutes: number;
  /** The data key wrapped by the PIN; null after too many wrong PINs. */
  pin: { salt: string; iterations: number; box: Box } | null;
  /** The data key wrapped by the server's key for this clinician. */
  server: { keyId: string; box: Box };
  /** Wrong PINs since the last right one. */
  failures: number;
  createdAt: string;
}

export const PBKDF2_ITERATIONS = 600_000;
export const MAX_PIN_FAILURES = 5;
export const MIN_PIN_LENGTH = 6;

export interface DataKey {
  key: CryptoKey;
  /** Kept while open, to wrap again for a new PIN; dropped on lock. */
  raw: Uint8Array;
}

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Box> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, data as BufferSource));
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function decryptBytes(key: CryptoKey, box: Box): Promise<Uint8Array | null> {
  try {
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(box.iv) as BufferSource }, key, fromB64(box.ct) as BufferSource);
    return new Uint8Array(pt);
  } catch {
    // AES-GCM authenticates: a wrong key or an altered record fails here.
    return null;
  }
}

async function pinKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", enc.encode(pin) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Why a PIN can't be used; null when it can. */
export function pinProblem(pin: string): string | null {
  if (pin.length < MIN_PIN_LENGTH) return `Use at least ${MIN_PIN_LENGTH} characters. Letters make it much harder to guess.`;
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) {
    return "That PIN is too easy to guess: avoid repeated or consecutive digits.";
  }
  return null;
}

/** A new data key for a device's copy. */
export async function newDataKey(): Promise<DataKey> {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return { key: await aesKey(raw), raw };
}

/** The vault for a new copy: the data key wrapped by the PIN and by the server's key. */
export async function sealVault(a: {
  data: DataKey;
  pin: string;
  serverKey: { keyId: string; key: string };
  userId: string;
  orgId: string;
  idleMinutes: number;
  now: Date;
  iterations?: number;
}): Promise<VaultRecord> {
  const iterations = a.iterations ?? PBKDF2_ITERATIONS;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const pinBox = await encryptBytes(await pinKey(a.pin, salt, iterations), a.data.raw);
  const serverBox = await encryptBytes(await aesKey(fromB64(a.serverKey.key)), a.data.raw);
  return {
    v: 2,
    userId: a.userId,
    orgId: a.orgId,
    idleMinutes: a.idleMinutes,
    pin: { salt: toB64(salt), iterations, box: pinBox },
    server: { keyId: a.serverKey.keyId, box: serverBox },
    failures: 0,
    createdAt: a.now.toISOString(),
  };
}

/** The vault with a new PIN, for an open copy (a PIN changed, or set again after a lockout). */
export async function rewrapPin(v: VaultRecord, data: DataKey, pin: string, iterations = PBKDF2_ITERATIONS): Promise<VaultRecord> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return {
    ...v,
    pin: { salt: toB64(salt), iterations, box: await encryptBytes(await pinKey(pin, salt, iterations), data.raw) },
    failures: 0,
  };
}

export type PinOpen =
  | { ok: true; data: DataKey; vault: VaultRecord }
  | { ok: false; reason: "wrong" | "locked_out"; vault: VaultRecord };

/**
 * Open with the PIN. A wrong one is counted; the fifth drops the PIN's
 * wrapping (the vault returned is the one to store either way).
 */
export async function openWithPin(v: VaultRecord, pin: string): Promise<PinOpen> {
  if (!v.pin) return { ok: false, reason: "locked_out", vault: v };
  const raw = await decryptBytes(await pinKey(pin, fromB64(v.pin.salt), v.pin.iterations), v.pin.box);
  if (raw) return { ok: true, data: { key: await aesKey(raw), raw }, vault: { ...v, failures: 0 } };
  const failures = v.failures + 1;
  if (failures >= MAX_PIN_FAILURES) return { ok: false, reason: "locked_out", vault: { ...v, pin: null, failures } };
  return { ok: false, reason: "wrong", vault: { ...v, failures } };
}

/** Open with the server's key for this clinician; null when it is not the key the copy was saved with. */
export async function openWithServerKey(v: VaultRecord, serverKey: { keyId: string; key: string }): Promise<DataKey | null> {
  if (serverKey.keyId !== v.server.keyId) return null;
  const raw = await decryptBytes(await aesKey(fromB64(serverKey.key)), v.server.box);
  return raw ? { key: await aesKey(raw), raw } : null;
}

/** A record sealed under the copy's data key. */
export async function seal(data: DataKey, value: unknown): Promise<Box> {
  return encryptBytes(data.key, enc.encode(JSON.stringify(value)));
}

/** A sealed record opened; throws when the key is not the one it was sealed with. */
export async function unseal<T>(data: DataKey, box: Box): Promise<T> {
  const pt = await decryptBytes(data.key, box);
  if (!pt) throw new Error("The offline record could not be opened with this key.");
  return JSON.parse(dec.decode(pt)) as T;
}
