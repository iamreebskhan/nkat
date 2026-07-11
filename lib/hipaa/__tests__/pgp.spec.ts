/** applyPhiKeyIfConfigured — the in-transaction PHI-key hook (0034 dual-write). */
import { afterEach, describe, expect, it } from "vitest";

import { PHI_KEY_ENV_VAR, applyPhiKeyIfConfigured, isPgcryptoConfigured } from "../pgp";

const ORIGINAL = process.env[PHI_KEY_ENV_VAR];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[PHI_KEY_ENV_VAR];
  else process.env[PHI_KEY_ENV_VAR] = ORIGINAL;
});

function fakeTx() {
  const executed: string[] = [];
  return {
    executed,
    $executeRawUnsafe: (q: string) => {
      executed.push(q);
      return Promise.resolve();
    },
  };
}

describe("applyPhiKeyIfConfigured", () => {
  it("no key → returns false and touches nothing (dual-write stays opt-in)", async () => {
    delete process.env[PHI_KEY_ENV_VAR];
    const tx = fakeTx();
    expect(await applyPhiKeyIfConfigured(tx)).toBe(false);
    expect(tx.executed).toEqual([]);
    expect(isPgcryptoConfigured()).toBe(false);
  });

  it("short key (<32) → treated as unconfigured", async () => {
    process.env[PHI_KEY_ENV_VAR] = "too-short";
    expect(await applyPhiKeyIfConfigured(fakeTx())).toBe(false);
  });

  it("valid key → SET LOCAL app.phi_key inside the open tx", async () => {
    process.env[PHI_KEY_ENV_VAR] = "k".repeat(32);
    const tx = fakeTx();
    expect(await applyPhiKeyIfConfigured(tx)).toBe(true);
    expect(tx.executed[0]).toContain("SET LOCAL app.phi_key");
  });

  it("single quotes in the key are escaped (no SQL breakage)", async () => {
    process.env[PHI_KEY_ENV_VAR] = "a'b".padEnd(32, "x");
    const tx = fakeTx();
    await applyPhiKeyIfConfigured(tx);
    expect(tx.executed[0]).toContain("a''b");
  });
});
