/**
 * The device's offline copy and drafts, in IndexedDB (browser only), sealed
 * (0121; offline-vault.ts says how).
 *
 * One store for the saved copy (a single record, the signed-in clinician's),
 * one for drafts keyed by visit and section, and one for the vault: the copy's
 * data key, wrapped by the clinician's PIN and by the server's key for them.
 * Every record is sealed under that data key, so what sits on the device is
 * unreadable until the copy is opened, with the PIN (no signal) or by being
 * signed in. Nothing here is sent anywhere; offline-sync.ts sends drafts.
 *
 * Cleared at sign-out, and when a different clinician signs in on the device
 * (OfflineCopy page), so one person's patients never sit under another's login.
 *
 * Written before 0121 and found here: a plain copy is deleted on sight (it is
 * a cache, saved again in a moment), and plain drafts — someone's unsent
 * notes — are read as they are and sealed the next time the copy is open.
 */
import type { OfflineDraft, OfflineSnapshot } from "./offline";
import {
  newDataKey,
  openWithPin,
  openWithServerKey,
  rewrapPin,
  seal,
  sealVault,
  unseal,
  type Box,
  type DataKey,
  type VaultRecord,
} from "./offline-vault";

const DB_NAME = "pallio-offline";
const DB_VERSION = 2;
const SNAPSHOT = "snapshot";
const DRAFTS = "drafts";
const VAULT = "vault";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOT)) db.createObjectStore(SNAPSHOT);
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(VAULT)) db.createObjectStore(VAULT);
      // A copy saved before 0121 is plain text: gone the moment this version
      // opens. Drafts are kept (see the header).
      if (e.oldVersion > 0 && e.oldVersion < 2) req.transaction?.objectStore(SNAPSHOT).clear();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** One request in its own transaction, resolved when the transaction is. */
async function run<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      let result: T;
      const req = op(t.objectStore(store));
      if (req) req.onsuccess = () => (result = req.result as T);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** The copy is locked: open it with the PIN, or by being signed in. */
export class OfflineLockedError extends Error {
  constructor() {
    super("The offline copy is locked.");
    this.name = "OfflineLockedError";
  }
}

/** The copy's data key while it is open on this page; null when locked. */
let opened: DataKey | null = null;

export const isUnlocked = () => opened !== null;

/** Forget the data key: everything on the device is sealed again. */
export function lockOffline(): void {
  opened = null;
}

function dataKey(): DataKey {
  if (!opened) throw new OfflineLockedError();
  return opened;
}

export const getVault = () => run<VaultRecord | undefined>(VAULT, "readonly", (s) => s.get("current"));
const putVault = (v: VaultRecord) => run<void>(VAULT, "readwrite", (s) => s.put(v, "current"));

/** The server's key for the signed-in clinician; null offline, signed out or with no key set up. */
async function serverKey(): Promise<{ keyId: string; key: string } | null> {
  try {
    const res = await fetch("/api/offline/key", { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return d.success ? (d.data as { keyId: string; key: string }) : null;
  } catch {
    return null;
  }
}

/** Open the copy by being signed in. False offline, signed out, or with no copy. */
export async function unlockWithSignIn(): Promise<boolean> {
  if (opened) return true;
  const v = await getVault();
  if (!v) return false;
  const k = await serverKey();
  if (!k) return false;
  const data = await openWithServerKey(v, k);
  if (!data) return false;
  opened = data;
  await sealPlainDrafts();
  return true;
}

export type PinResult = "ok" | "wrong" | "locked_out" | "no_copy";

/** Open the copy with the PIN. The fifth wrong one leaves only signing in. */
export async function unlockWithPin(pin: string): Promise<PinResult> {
  const v = await getVault();
  if (!v) return "no_copy";
  const r = await openWithPin(v, pin);
  await putVault(r.vault);
  if (!r.ok) return r.reason;
  opened = r.data;
  await sealPlainDrafts();
  return "ok";
}

/**
 * A vault for a new copy, sealed with this PIN. Needs the server's key, so it
 * is made only online and signed in; "offline" otherwise.
 */
export async function createVault(a: { pin: string; userId: string; orgId: string; idleMinutes: number }): Promise<"ok" | "offline" | "exists"> {
  // Never over a sealed copy: its drafts could not be opened again.
  if (await getVault()) return "exists";
  const k = await serverKey();
  if (!k) return "offline";
  const data = await newDataKey();
  const v = await sealVault({ data, pin: a.pin, serverKey: k, userId: a.userId, orgId: a.orgId, idleMinutes: a.idleMinutes, now: new Date() });
  // A copy sealed under another key could never be read again.
  await run<void>(SNAPSHOT, "readwrite", (s) => s.clear());
  await putVault(v);
  opened = data;
  await sealPlainDrafts();
  return "ok";
}

/**
 * The practice's idle limit as it stands when the copy is saved again: a
 * shorter (or longer) limit set since the vault was made reaches the lock.
 */
export async function setVaultIdleMinutes(idleMinutes: number): Promise<void> {
  const v = await getVault();
  if (!v || v.idleMinutes === idleMinutes) return;
  await putVault({ ...v, idleMinutes });
}

/** A new PIN for the open copy: changed, or set again after too many wrong ones. */
export async function setPin(pin: string): Promise<void> {
  const v = await getVault();
  if (!v) throw new OfflineLockedError();
  await putVault(await rewrapPin(v, dataKey(), pin));
}

type SnapshotRecord = { enc?: Box };

export async function getSnapshot(): Promise<OfflineSnapshot | undefined> {
  const rec = await run<SnapshotRecord | undefined>(SNAPSHOT, "readonly", (s) => s.get("current"));
  if (!rec) return undefined;
  if (!rec.enc) {
    // Plain text from before 0121: not kept.
    await clearSnapshot();
    return undefined;
  }
  return unseal<OfflineSnapshot>(dataKey(), rec.enc);
}

export async function putSnapshot(snap: OfflineSnapshot): Promise<void> {
  const enc = await seal(dataKey(), snap);
  await run<void>(SNAPSHOT, "readwrite", (s) => s.put({ enc } satisfies SnapshotRecord, "current"));
}

/** A draft as stored: only its ids and time in the clear. */
type DraftRecord = { id: string; visitId: string; savedAt: string; enc: Box };
const isSealed = (r: DraftRecord | OfflineDraft): r is DraftRecord => "enc" in r && Boolean((r as DraftRecord).enc);

export async function listDrafts(): Promise<OfflineDraft[]> {
  const rows = await run<(DraftRecord | OfflineDraft)[]>(DRAFTS, "readonly", (s) => s.getAll());
  const out: OfflineDraft[] = [];
  for (const r of rows) out.push(isSealed(r) ? await unseal<OfflineDraft>(dataKey(), r.enc) : r);
  return out;
}

export async function putDraft(d: OfflineDraft): Promise<void> {
  const rec: DraftRecord = { id: d.id, visitId: d.visitId, savedAt: d.savedAt, enc: await seal(dataKey(), d) };
  await run<void>(DRAFTS, "readwrite", (s) => s.put(rec));
}

export const deleteDraft = (id: string) => run<void>(DRAFTS, "readwrite", (s) => s.delete(id));

/** How many drafts wait on the device, without opening it. */
export const countDrafts = () => run<number>(DRAFTS, "readonly", (s) => s.count());

/** Drafts written before 0121, sealed now that the copy is open. */
async function sealPlainDrafts(): Promise<void> {
  const rows = await run<(DraftRecord | OfflineDraft)[]>(DRAFTS, "readonly", (s) => s.getAll());
  for (const r of rows) if (!isSealed(r)) await putDraft(r);
}

/** Everything on this device: the copy, every draft and the vault. */
export async function clearOfflineData(): Promise<void> {
  opened = null;
  await run<void>(SNAPSHOT, "readwrite", (s) => s.clear());
  await run<void>(DRAFTS, "readwrite", (s) => s.clear());
  await run<void>(VAULT, "readwrite", (s) => s.clear());
}

/** The copy alone: drafts are the clinician's work and stay until sent. */
export const clearSnapshot = () => run<void>(SNAPSHOT, "readwrite", (s) => s.clear());

/** Whether this browser can keep an offline copy at all. */
export const offlineSupported = () => typeof indexedDB !== "undefined" && typeof globalThis.crypto?.subtle !== "undefined";
