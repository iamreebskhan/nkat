/**
 * Who must use a second factor, and when a session has run out (0121).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import {
  DEFAULT_SESSION_POLICY,
  mfaRequiredFor,
  readSessionPolicy,
  sessionIsIdle,
} from "../session-policy";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("mfaRequiredFor", () => {
  it("requires it of admins and billers by role", () => {
    for (const role of ["platform_admin", "org_admin", "billing_agent"]) {
      expect(mfaRequiredFor(role, [], "admins_and_billers")).toBe(true);
    }
  });

  it("requires it of anyone holding an admin's or a biller's grant, whatever the role", () => {
    expect(mfaRequiredFor("clinician", ["patients.view", "billing.superbills.export"], "admins_and_billers")).toBe(true);
    expect(mfaRequiredFor("read_only", ["team.permissions"], "admins_and_billers")).toBe(true);
  });

  it("CONTROL — not of a clinician with a clinician's grants", () => {
    const clinician = ["patients.list", "patients.view", "visits.create", "visits.submit", "careplans.edit", "schedule.edit"];
    expect(mfaRequiredFor("clinician", clinician, "admins_and_billers")).toBe(false);
    expect(mfaRequiredFor("intake_coordinator", ["patients.create", "schedule.manage.all"], "admins_and_billers")).toBe(false);
  });

  it("requires it of everyone under the 'everyone' policy", () => {
    expect(mfaRequiredFor("clinician", ["patients.view"], "everyone")).toBe(true);
    expect(mfaRequiredFor("read_only", [], "everyone")).toBe(true);
  });
});

describe("sessionIsIdle", () => {
  const act = 1_800_000_000;

  it("is live up to the limit and idle one second past it", () => {
    expect(sessionIsIdle({ act, idle: 15 }, act + 15 * 60)).toBe(false);
    expect(sessionIsIdle({ act, idle: 15 }, act + 15 * 60 + 1)).toBe(true);
  });

  it("follows the org's limit, not a fixed one", () => {
    expect(sessionIsIdle({ act, idle: 5 }, act + 6 * 60)).toBe(true);
    expect(sessionIsIdle({ act, idle: 60 }, act + 59 * 60)).toBe(false);
  });
});

describe("readSessionPolicy", () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.mocked(withOrgContext).mockReset();
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const answer = (row: Record<string, unknown> | null) =>
    vi.mocked(withOrgContext).mockImplementation((async (_o: string, fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: () => Promise.resolve(row ? [row] : []) })) as never);

  it("reads the org's limit and policy", async () => {
    answer({ idle_timeout_minutes: 30, mfa_policy: "everyone" });
    expect(await readSessionPolicy(ORG)).toEqual({ idleMinutes: 30, mfaPolicy: "everyone" });
    expect(withOrgContext).toHaveBeenCalledWith(ORG, expect.any(Function));
  });

  it("falls back to the strict defaults when the read fails", async () => {
    vi.mocked(withOrgContext).mockRejectedValue(new Error("db down"));
    expect(await readSessionPolicy(ORG)).toEqual(DEFAULT_SESSION_POLICY);
  });

  it("lets a developer lengthen the limit locally, and never in production", async () => {
    answer({ idle_timeout_minutes: 15, mfa_policy: "admins_and_billers" });
    vi.stubEnv("PALLIO_DEV_IDLE_MINUTES", "480");
    vi.stubEnv("NODE_ENV", "development");
    expect((await readSessionPolicy(ORG)).idleMinutes).toBe(480);
    // CONTROL: the same setting in production is ignored.
    vi.stubEnv("NODE_ENV", "production");
    expect((await readSessionPolicy(ORG)).idleMinutes).toBe(15);
    vi.unstubAllEnvs();
  });
});
