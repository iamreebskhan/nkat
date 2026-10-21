/**
 * harnessAccount() is the one place a harness script learns whose account to
 * sign in as, so it is where the demo tenant gets refused (R36).
 *
 * process.exit is stubbed to THROW. The real one would end the test run, and
 * a stub that only recorded the call would let harnessAccount() carry on and
 * hand back credentials after "refusing". That is the failure under test, so
 * the stub must not be able to hide it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HARNESS_EMAIL, HARNESS_ORG, harnessAccount } from "@/scripts/lib/test-credentials.mjs";

const KEYS = ["TEST_EMAIL", "TEST_ORG", "TEST_PASSWORD"] as const;
const PASSWORD = "Tp-harness-spec-fixture-9aZ!";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TEST_PASSWORD = PASSWORD;
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const printed = () => vi.mocked(console.error).mock.calls.flat().join("\n");

describe("harnessAccount", () => {
  it("defaults to the harness org on the reserved test domain", () => {
    expect(harnessAccount()).toEqual({
      email: "harness@pallio-smoke.test",
      orgName: "Pallio Harness",
      fullName: "Harness Runner",
      password: PASSWORD,
    });
    expect(HARNESS_EMAIL).toMatch(/@pallio-smoke\.test$/);
    expect(HARNESS_ORG).toBe("Pallio Harness");
  });

  describe("refuses the demo tenant: exit 2, before any request", () => {
    it.each([
      ["the old demo login", { TEST_EMAIL: "livedemo@pallio.io" }],
      ["the same login, recased and padded", { TEST_EMAIL: "  LiveDemo@Pallio.IO " }],
      ["a seat on the R20 tenant", { TEST_EMAIL: "dr.x@demo.pallio.io" }],
      ["the old demo org by name", { TEST_ORG: "Pallio Live Demo" }],
      ["the old demo org by slug", { TEST_ORG: "pallio-live-demo" }],
      ["the R20 org by name", { TEST_ORG: "Pallio Demo Palliative Care" }],
    ])("%s", (_label, env) => {
      Object.assign(process.env, env);
      expect(() => harnessAccount()).toThrow("exit 2");
      expect(printed()).toMatch(/^refusing: .+ is the demo tenant/);
    });

    it("says why even when no password is set", () => {
      // The runbook's proof command runs without TEST_PASSWORD. Had the password
      // check run first, that command would exit 2 for the wrong reason and
      // prove nothing about the guard.
      delete process.env.TEST_PASSWORD;
      process.env.TEST_EMAIL = "livedemo@pallio.io";
      expect(() => harnessAccount()).toThrow("exit 2");
      expect(printed()).toMatch(/refusing: livedemo@pallio\.io is the demo tenant/);
      expect(printed()).not.toMatch(/TEST_PASSWORD is not set/);
    });
  });

  it("exits 2 without a password rather than reaching for a default", () => {
    delete process.env.TEST_PASSWORD;
    expect(() => harnessAccount()).toThrow("exit 2");
    expect(printed()).toMatch(/TEST_PASSWORD is not set/);
    expect(printed()).toMatch(/harness account/);
  });

  describe("controls: each must be ACCEPTED", () => {
    it("another account on the test domain", () => {
      process.env.TEST_EMAIL = "someone@pallio-smoke.test";
      expect(harnessAccount().email).toBe("someone@pallio-smoke.test");
    });

    it("addresses that merely contain 'demo'", () => {
      process.env.TEST_EMAIL = "demo-runner@pallio-smoke.test";
      expect(harnessAccount().email).toBe("demo-runner@pallio-smoke.test");
      process.env.TEST_EMAIL = "x@notdemo.pallio.io";
      expect(harnessAccount().email).toBe("x@notdemo.pallio.io");
    });

    it("an org that merely contains 'Pallio'", () => {
      process.env.TEST_ORG = "Pallio Harness Two";
      expect(harnessAccount().orgName).toBe("Pallio Harness Two");
    });
  });
});
