/**
 * The offline copy's sealing (0121; ONC (d)(7)). Real Web Crypto: what a
 * record looks like at rest, who can open it, and what five wrong PINs do.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_PIN_FAILURES,
  newDataKey,
  openWithPin,
  openWithServerKey,
  pinProblem,
  rewrapPin,
  seal,
  sealVault,
  toB64,
  unseal,
  type VaultRecord,
} from "../offline-vault";

// Few rounds keep the suite quick; the derivation is the same at 600,000.
const ITER = 1_000;
const SERVER = { keyId: "v1", key: toB64(new Uint8Array(32).fill(7)) };
const OTHER_SERVER = { keyId: "v1", key: toB64(new Uint8Array(32).fill(8)) };

async function vaultWith(pin: string): Promise<{ v: VaultRecord; data: Awaited<ReturnType<typeof newDataKey>> }> {
  const data = await newDataKey();
  const v = await sealVault({
    data, pin, serverKey: SERVER, userId: "u1", orgId: "o1", idleMinutes: 15, now: new Date("2026-10-31T09:00:00Z"), iterations: ITER,
  });
  return { v, data };
}

const SNAP = { patients: [{ name: "Ruth Testcase", medications: ["Morphine IR 5 mg PRN"] }] };

describe("sealing", () => {
  it("keeps nothing readable at rest", async () => {
    const { data } = await vaultWith("hush-482917");
    const box = await seal(data, SNAP);
    const atRest = JSON.stringify(box);
    expect(atRest).not.toContain("Ruth");
    expect(atRest).not.toContain("Morphine");
    expect(await unseal(data, box)).toEqual(SNAP);
  });

  it("refuses another copy's key", async () => {
    const a = await vaultWith("hush-482917");
    const b = await vaultWith("hush-482917");
    const box = await seal(a.data, SNAP);
    await expect(unseal(b.data, box)).rejects.toThrow();
  });
});

describe("opening", () => {
  it("opens with the right PIN, and the key opens what was sealed", async () => {
    const { v, data } = await vaultWith("hush-482917");
    const box = await seal(data, SNAP);
    const r = await openWithPin(v, "hush-482917");
    expect(r.ok).toBe(true);
    if (r.ok) expect(await unseal(r.data, box)).toEqual(SNAP);
  });

  it("CONTROL — a wrong PIN opens nothing and is counted", async () => {
    const { v } = await vaultWith("hush-482917");
    const r = await openWithPin(v, "hush-482918");
    expect(r).toMatchObject({ ok: false, reason: "wrong" });
    expect(r.vault.failures).toBe(1);
  });

  it("drops the PIN's wrapping at the fifth wrong PIN, and the right one no longer opens it", async () => {
    let { v } = await vaultWith("hush-482917");
    for (let i = 1; i < MAX_PIN_FAILURES; i++) {
      const r = await openWithPin(v, "wrong-000000");
      expect(r).toMatchObject({ ok: false, reason: "wrong" });
      v = r.vault;
    }
    const last = await openWithPin(v, "wrong-000000");
    expect(last).toMatchObject({ ok: false, reason: "locked_out" });
    expect(last.vault.pin).toBeNull();
    expect(await openWithPin(last.vault, "hush-482917")).toMatchObject({ ok: false, reason: "locked_out" });
  });

  it("still opens by sign-in after a lockout, and takes a new PIN", async () => {
    const { v, data } = await vaultWith("hush-482917");
    const box = await seal(data, SNAP);
    const locked = { ...v, pin: null, failures: MAX_PIN_FAILURES };
    const viaServer = await openWithServerKey(locked, SERVER);
    expect(viaServer).not.toBeNull();
    expect(await unseal(viaServer!, box)).toEqual(SNAP);
    const renewed = await rewrapPin(locked, viaServer!, "fresh-639204", ITER);
    expect(renewed.failures).toBe(0);
    const r = await openWithPin(renewed, "fresh-639204");
    expect(r.ok).toBe(true);
  });

  it("CONTROL — another clinician's server key opens nothing", async () => {
    const { v } = await vaultWith("hush-482917");
    expect(await openWithServerKey(v, OTHER_SERVER)).toBeNull();
    expect(await openWithServerKey(v, { ...SERVER, keyId: "v2" })).toBeNull();
  });
});

describe("pinProblem", () => {
  it("refuses short and trivial PINs", () => {
    expect(pinProblem("12345")).not.toBeNull();
    expect(pinProblem("111111")).not.toBeNull();
    expect(pinProblem("123456")).not.toBeNull();
    expect(pinProblem("987654")).not.toBeNull();
  });

  it("CONTROL — takes a PIN that isn't trivial", () => {
    expect(pinProblem("482917")).toBeNull();
    expect(pinProblem("hush-482917")).toBeNull();
  });
});
