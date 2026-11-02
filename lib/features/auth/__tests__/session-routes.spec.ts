/**
 * The routes around the session's idle clock and second factor (0121), run
 * for real against lib/auth.ts with only the cookie jar, env, org policy and
 * the database-touching services stood in for.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret-not-real-0123456789-abcdefghij";
const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
const h = vi.hoisted(() => ({
  audit: vi.fn(),
  confirm: vi.fn(),
  setup: vi.fn(),
  disable: vi.fn(),
  activeUser: vi.fn(),
  sessionFor: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (jar.value === undefined ? undefined : { value: jar.value }),
    set: (_n: string, v: string) => {
      jar.value = v;
    },
    delete: () => {
      jar.value = undefined;
    },
  }),
}));
vi.mock("@/lib/env", () => ({
  env: () => ({ JWT_SECRET: SECRET, JWT_EXPIRES_IN: "7d", COOKIE_NAME: "pallio_session", NODE_ENV: "test" }),
}));
vi.mock("@/lib/features/auth/session-policy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/features/auth/session-policy")>();
  return { ...real, readSessionPolicy: vi.fn() };
});
vi.mock("@/lib/features/audit/audit-write", () => ({ recordAuditDetached: h.audit }));
vi.mock("@/lib/features/auth/mfa.service", () => ({
  confirmMfaSetup: h.confirm,
  setupMfa: h.setup,
  disableMfa: h.disable,
}));
vi.mock("@/lib/features/auth/auth.service", () => ({
  activeUserById: h.activeUser,
  sessionForUser: h.sessionFor,
}));
vi.mock("@/lib/db", () => ({ prisma: { $executeRaw: h.executeRaw } }));

import { GET as activityGet, POST as activityPost } from "@/app/api/auth/activity/route";
import { POST as disablePost } from "@/app/api/auth/mfa/disable/route";
import { POST as enrolPost } from "@/app/api/auth/mfa/enrol/route";
import { POST as enrolVerifyPost } from "@/app/api/auth/mfa/enrol/verify/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { getSession, signSession, type Session } from "@/lib/auth";
import { __resetThrottle } from "@/lib/features/auth/login-throttle";
import { signEnrolToken } from "@/lib/features/auth/mfa-enrol-token";
import { readSessionPolicy } from "@/lib/features/auth/session-policy";

const ADMIN: Session = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: "11111111-1111-4111-8111-111111111111",
  role: "org_admin",
  permissions: ["patients.view", "team.permissions"],
  email: "admin@example.test",
};
const NURSE: Session = { ...ADMIN, role: "clinician", permissions: ["patients.view"], email: "nurse@example.test" };

const now = () => Math.floor(Date.now() / 1000);
const req = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  jar.value = undefined;
  __resetThrottle();
  vi.mocked(readSessionPolicy).mockResolvedValue({ idleMinutes: 15, mfaPolicy: "admins_and_billers" });
  h.executeRaw.mockResolvedValue(1);
});

describe("/api/auth/activity", () => {
  it("POST moves the idle clock to now", async () => {
    jar.value = await signSession(NURSE, { act: now() - 10 * 60 });
    const res = await activityPost();
    expect(res.status).toBe(200);
    const s = await getSession();
    expect(Math.abs(s!.act - now())).toBeLessThanOrEqual(2);
    expect((await res.json()).data.idleMinutes).toBe(15);
  });

  it("GET reports the clock without moving it", async () => {
    const act = now() - 10 * 60;
    jar.value = await signSession(NURSE, { act });
    const res = await activityGet();
    expect((await res.json()).data.act).toBe(act);
    expect((await getSession())!.act).toBe(act);
  });

  it("refuses a session already past its limit: activity cannot revive it", async () => {
    jar.value = await signSession(NURSE, { act: now() - 16 * 60 });
    const res = await activityPost();
    expect(res.status).toBe(401);
    expect(await getSession()).toBeNull();
  });

  it("keeps a second factor the session already has", async () => {
    jar.value = await signSession(ADMIN, { mfa: true, act: now() - 60 });
    await activityPost();
    expect((await getSession())!.mfa).toBe(true);
  });

  it("says so when the refresh leaves the session owing a second factor: the org switched to 'everyone' under it", async () => {
    jar.value = await signSession(NURSE, { act: now() - 120 });
    vi.mocked(readSessionPolicy).mockResolvedValue({ idleMinutes: 15, mfaPolicy: "everyone" });
    const res = await activityPost();
    expect((await res.json()).data.mfaPending).toBe(true);
    expect(await getSession()).toMatchObject({ mfaReq: true, mfa: false });
  });

  it("CONTROL — owes nothing when the role isn't required one", async () => {
    jar.value = await signSession(NURSE, { act: now() - 120 });
    const res = await activityPost();
    expect((await res.json()).data.mfaPending).toBe(false);
  });

  it("CONTROL — owes nothing once it signed in with one, whatever the policy says", async () => {
    jar.value = await signSession(NURSE, { mfa: true, act: now() - 120 });
    vi.mocked(readSessionPolicy).mockResolvedValue({ idleMinutes: 15, mfaPolicy: "everyone" });
    const res = await activityPost();
    expect((await res.json()).data.mfaPending).toBe(false);
  });
});

describe("/api/auth/logout", () => {
  it("records a sign-out at the idle limit with its reason, even though the session is no longer valid", async () => {
    jar.value = await signSession(NURSE, { act: now() - 3600 });
    const res = await logoutPost(req({ reason: "idle" }));
    expect(res.status).toBe(200);
    expect(jar.value).toBeUndefined();
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "logout", userId: NURSE.userId, orgId: NURSE.orgId, payload: { reason: "idle" } }),
    );
  });

  it("CONTROL — a sign-out by hand is recorded as one, and anything else is not 'idle'", async () => {
    jar.value = await signSession(NURSE);
    await logoutPost(req({ reason: "whatever" }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ payload: { reason: "manual" } }));
  });
});

describe("/api/auth/mfa/enrol + verify — a second factor set up at sign-in", () => {
  const pass = () => signEnrolToken({ userId: ADMIN.userId, orgId: ADMIN.orgId, email: ADMIN.email });

  it("starts the setup for the account the pass names", async () => {
    h.setup.mockResolvedValue({ secretBase32: "ABC", otpauthUri: "otpauth://totp/x" });
    const res = await enrolPost(req({ token: await pass() }));
    expect(res.status).toBe(200);
    expect(h.setup).toHaveBeenCalledWith({ userId: ADMIN.userId, email: ADMIN.email });
  });

  it("refuses a pass that is not one — a session token is not a pass", async () => {
    const sessionToken = await signSession(ADMIN, { mfa: true });
    expect((await enrolPost(req({ token: sessionToken }))).status).toBe(401);
    expect((await enrolPost(req({ token: "x".repeat(40) }))).status).toBe(401);
    expect(h.setup).not.toHaveBeenCalled();
  });

  it("signs in with the second factor recorded once the code matches", async () => {
    h.confirm.mockResolvedValue({ confirmed: true, recoveryCodes: ["a1b2c3d4e5"] });
    h.activeUser.mockResolvedValue({ id: ADMIN.userId, email: ADMIN.email, is_platform_admin: false });
    h.sessionFor.mockResolvedValue(ADMIN);
    const res = await enrolVerifyPost(req({ token: await pass(), code: "123456" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.recoveryCodes).toEqual(["a1b2c3d4e5"]);
    const s = await getSession();
    expect(s).toMatchObject({ userId: ADMIN.userId, mfa: true, mfaReq: true });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "mfa_change", payload: { change: "enrolled", via: "login" } }));
  });

  it("CONTROL — a wrong code signs nobody in, and counts against the address", async () => {
    h.confirm.mockResolvedValue({ error: "bad_code" });
    const token = await pass();
    const headers = { "x-real-ip": "203.0.113.9" };
    for (let i = 0; i < 5; i++) {
      expect((await enrolVerifyPost(req({ token, code: "000000" }, headers))).status).toBe(422);
    }
    expect(jar.value).toBeUndefined();
    // The sixth try from the same address is refused before the code is checked.
    expect((await enrolVerifyPost(req({ token, code: "000000" }, headers))).status).toBe(429);
    expect(h.confirm).toHaveBeenCalledTimes(5);
  });

  it("refuses an account suspended since the pass was issued", async () => {
    h.confirm.mockResolvedValue({ confirmed: true, recoveryCodes: [] });
    h.activeUser.mockResolvedValue(null);
    const res = await enrolVerifyPost(req({ token: await pass(), code: "123456" }));
    expect(res.status).toBe(403);
    expect(jar.value).toBeUndefined();
  });
});

describe("/api/auth/mfa/disable", () => {
  it("refuses while the role requires a second factor", async () => {
    jar.value = await signSession(ADMIN, { mfa: true });
    const res = await disablePost();
    expect(res.status).toBe(422);
    expect(h.disable).not.toHaveBeenCalled();
  });

  it("CONTROL — turns it off for a role that doesn't require it, and records it", async () => {
    jar.value = await signSession(NURSE, { mfa: true });
    expect((await disablePost()).status).toBe(200);
    expect(h.disable).toHaveBeenCalledWith(NURSE.userId);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "mfa_change", payload: { change: "disabled" } }));
  });

  it("reads the policy now: an org that switched to 'everyone' keeps the clinician's too", async () => {
    jar.value = await signSession(NURSE, { mfa: true });
    vi.mocked(readSessionPolicy).mockResolvedValue({ idleMinutes: 15, mfaPolicy: "everyone" });
    expect((await disablePost()).status).toBe(422);
  });
});
