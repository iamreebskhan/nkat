/**
 * The one sentence the browser's MFA flow is keyed on.
 *
 * POST /api/auth/login answers an enrolled account that sent no code with 401
 * and a line of prose. app/(auth)/login/page.tsx does not merely display it —
 * it MATCHES it: `/mfa code required/i.test(data.error)` is the whole test
 * that flips the form from the password field to the code field. Reword the
 * route and the form never flips, so an enrolled clinician types the right
 * password, reads "MFA code required." as a dead end and cannot sign in at
 * all. Nothing else in the repo runs both halves, and login-refusals.spec.ts
 * next door only quotes the strings in comments.
 *
 * So this executes the real handler and tests the body it actually returns
 * against the regex read out of the page's own source: reword either side and
 * this goes red, without pinning the copy to a string typed twice here.
 */
import { readFileSync } from "node:fs";

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  setSessionCookie: vi.fn(),
  signSession: vi.fn().mockResolvedValue("token"),
}));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/auth/auth.service", () => ({ login: vi.fn() }));

import { POST } from "@/app/api/auth/login/route";
import { login } from "@/lib/features/auth/auth.service";

/**
 * The stage flip as the login page writes it: the status it requires and the
 * pattern it runs over the error text.
 */
const stageFlip = (() => {
  const src = readFileSync(
    new URL("../../../../app/(auth)/login/page.tsx", import.meta.url),
    "utf8",
  );
  const m = src.match(/res\.status === (\d+) && (\/[^/]+\/[a-z]*)\.test\(data\.error/);
  if (!m) throw new Error("the login page no longer flips to MFA on the error text");
  const lit = m[2]!.match(/^\/(.+)\/([a-z]*)$/)!;
  return { status: Number(m[1]), test: new RegExp(lit[1]!, lit[2]!) };
})();

const post = () =>
  new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nurse@design-partner.test", password: "the-right-one" }),
  }) as unknown as NextRequest;

const answer = async () => {
  const res = await POST(post());
  return { status: res.status, error: (await res.json()).error as string };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/login — the MFA challenge the login form reads", () => {
  it("answers mfa_required in the status and words the form flips on", async () => {
    vi.mocked(login).mockResolvedValue({ error: "mfa_required" });
    const r = await answer();
    expect(r.status).toBe(stageFlip.status);
    expect(stageFlip.test.test(r.error)).toBe(true);
  });

  it("CONTROL — a bad code does NOT read as the challenge", async () => {
    // Both are 401s on the same path. If this one also matched, the form would
    // flip back to a blank code field and silently swallow the refusal, so the
    // user would retype the same wrong code forever with nothing said.
    vi.mocked(login).mockResolvedValue({ error: "mfa_bad_code" });
    const r = await answer();
    expect(r.status).toBe(401);
    expect(stageFlip.test.test(r.error)).toBe(false);
    expect(r.error).not.toBe("");
  });

  it("CONTROL — a wrong password does NOT read as the challenge", async () => {
    // Otherwise every failed sign-in would present a code field, and the
    // account's real refusal would never be shown.
    vi.mocked(login).mockResolvedValue({ error: "invalid_credentials" });
    const r = await answer();
    expect(r.status).toBe(401);
    expect(stageFlip.test.test(r.error)).toBe(false);
  });
});
