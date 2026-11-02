/**
 * The session token itself (0121): signed with the idle clock and the second
 * factor, refused past its idle limit, refused when it predates 0121, and a
 * second factor the role owes standing between the session and every route.
 *
 * lib/auth.ts runs for real — jose signs and verifies — with only the cookie
 * jar, the env and the org's policy stood in for.
 */
import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret-not-real-0123456789-abcdefghij";

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));

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

import {
  MFA_SETUP_REQUIRED,
  getSession,
  readSessionIdentity,
  requireAuth,
  signSession,
  type Session,
} from "@/lib/auth";
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

beforeEach(() => {
  jar.value = undefined;
  vi.mocked(readSessionPolicy).mockResolvedValue({ idleMinutes: 15, mfaPolicy: "admins_and_billers" });
});

describe("signSession / getSession", () => {
  it("carries the idle clock, the org's limit and the second factor", async () => {
    jar.value = await signSession(ADMIN, { mfa: true });
    const s = await getSession();
    expect(s).toMatchObject({ userId: ADMIN.userId, orgId: ADMIN.orgId, idle: 15, mfa: true, mfaReq: true });
    expect(Math.abs(s!.act - now())).toBeLessThanOrEqual(2);
  });

  it("refuses a session past its idle limit", async () => {
    jar.value = await signSession(NURSE, { act: now() - 15 * 60 - 5 });
    expect(await getSession()).toBeNull();
  });

  it("CONTROL — the same session just inside the limit is live", async () => {
    jar.value = await signSession(NURSE, { act: now() - 15 * 60 + 30 });
    expect(await getSession()).not.toBeNull();
  });

  it("follows the org's own limit", async () => {
    vi.mocked(readSessionPolicy).mockResolvedValue({ idleMinutes: 5, mfaPolicy: "admins_and_billers" });
    jar.value = await signSession(NURSE, { act: now() - 6 * 60 });
    expect(await getSession()).toBeNull();
  });

  it("refuses a token minted before 0121, which says nothing of its idle clock", async () => {
    jar.value = await new SignJWT({ ...NURSE })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .setIssuer("pallio")
      .setAudience("pallio-app")
      .sign(new TextEncoder().encode(SECRET));
    expect(await getSession()).toBeNull();
  });

  it("still names who an idle session belonged to, for the sign-out record", async () => {
    jar.value = await signSession(NURSE, { act: now() - 3600 });
    expect(await getSession()).toBeNull();
    expect(await readSessionIdentity()).toEqual({ userId: NURSE.userId, orgId: NURSE.orgId });
  });

  it("does not carry an old token's expiry or audience into a refreshed one", async () => {
    jar.value = await signSession(NURSE);
    const before = await getSession();
    jar.value = await signSession(before!, { act: now() });
    const after = await getSession();
    expect(after).not.toBeNull();
    expect(after!.email).toBe(NURSE.email);
  });
});

describe("requireAuth — a second factor the role owes", () => {
  it("refuses every route while it is owed", async () => {
    jar.value = await signSession(ADMIN, { mfa: false });
    const r = await requireAuth(["patients.view"]);
    expect(r).toBeInstanceOf(NextResponse);
    const res = r as NextResponse;
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(MFA_SETUP_REQUIRED);
  });

  it("lets through the routes that set it up", async () => {
    jar.value = await signSession(ADMIN, { mfa: false });
    const r = await requireAuth([], { allowPendingMfa: true });
    expect(r).not.toBeInstanceOf(NextResponse);
  });

  it("CONTROL — the same admin signed in with a second factor reaches the route", async () => {
    jar.value = await signSession(ADMIN, { mfa: true });
    const r = await requireAuth(["patients.view"]);
    expect(r).not.toBeInstanceOf(NextResponse);
  });

  it("CONTROL — a clinician whose role doesn't require one is never stopped for it", async () => {
    jar.value = await signSession(NURSE, { mfa: false });
    expect(await requireAuth(["patients.view"])).not.toBeInstanceOf(NextResponse);
  });

  it("an org that requires it of everyone stops the clinician too", async () => {
    vi.mocked(readSessionPolicy).mockResolvedValue({ idleMinutes: 15, mfaPolicy: "everyone" });
    jar.value = await signSession(NURSE, { mfa: false });
    expect(((await requireAuth(["patients.view"])) as NextResponse).status).toBe(403);
  });

  it("answers 401, not 403, once the session is idle", async () => {
    jar.value = await signSession(ADMIN, { mfa: true, act: now() - 3600 });
    expect(((await requireAuth()) as NextResponse).status).toBe(401);
  });
});
