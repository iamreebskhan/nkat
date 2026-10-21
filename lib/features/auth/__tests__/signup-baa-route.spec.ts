/**
 * POST /api/auth/signup refuses a declined BAA before the service is reached.
 *
 * The signup form only disables its own submit button, so the server is the
 * whole control. The route schema used to declare `baaAccepted: z.boolean()`,
 * which ACCEPTS false: a request that explicitly declined the Business
 * Associate Agreement was well-formed and went through to signup(), where a
 * single branch refused it. For a HIPAA agreement that is one line of defence
 * too few — and the org INSERT behind it writes org.baa_signed_at, the only
 * record anywhere that the customer ever signed.
 *
 * So both halves are pinned here: the schema refuses a declined BAA at the
 * door, and the service's own refusal still reaches the user if it is ever
 * asked. The real handler runs; only the session cookie and the service are
 * stood in for.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  setSessionCookie: vi.fn(),
  signSession: vi.fn().mockResolvedValue("token"),
}));
vi.mock("@/lib/features/auth/auth.service", () => ({ signup: vi.fn() }));

import { POST } from "@/app/api/auth/signup/route";
import { signup } from "@/lib/features/auth/auth.service";
import { __resetThrottle } from "@/lib/features/auth/login-throttle";

/** The sentence the route already used for this refusal on the service path. */
const BAA_LINE = "You must accept the Business Associate Agreement.";

const SESSION = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: "11111111-1111-4111-8111-111111111111",
  role: "org_admin" as const,
  permissions: ["patients.view"],
  email: "owner@riverside-pall.test",
};

const body = (over: Record<string, unknown> = {}) => ({
  email: "owner@riverside-pall.test",
  password: "quiet-harbor-lantern-49",
  fullName: "Practice Owner",
  orgName: "Riverside Palliative",
  baaAccepted: true,
  ...over,
});

const post = (payload: Record<string, unknown>) =>
  new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }) as unknown as NextRequest;

const send = async (payload: Record<string, unknown>) => {
  const res = await POST(post(payload));
  return { status: res.status, error: (await res.json()).error as string | null };
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetThrottle();
  vi.mocked(signup).mockResolvedValue({ session: SESSION });
});

describe("POST /api/auth/signup — the BAA", () => {
  it("refuses baaAccepted: false without reaching signup() at all", async () => {
    const r = await send(body({ baaAccepted: false }));
    expect(r.status).toBe(422);
    expect(r.error).toContain(BAA_LINE);
    // The point of the schema change: nothing downstream is asked to be the
    // one thing standing between a declined agreement and a live org row.
    expect(signup).not.toHaveBeenCalled();
  });

  it("refuses a body that omits baaAccepted, with the same sentence", async () => {
    const payload = body();
    delete (payload as { baaAccepted?: unknown }).baaAccepted;
    const r = await send(payload);
    expect(r.status).toBe(422);
    expect(r.error).toContain(BAA_LINE);
    expect(signup).not.toHaveBeenCalled();
  });

  it("still echoes the service's own refusal, so the second check is not dead", async () => {
    // Defence in depth only counts if the inner check is still wired to a
    // message. If signup() ever refuses for baa_required, the user must read
    // the same sentence rather than a blank 422.
    vi.mocked(signup).mockResolvedValue({ error: "baa_required" });
    const r = await send(body());
    expect(r.status).toBe(422);
    expect(r.error).toContain(BAA_LINE);
  });

  it("CONTROL — an accepted BAA goes through and the account is created", async () => {
    const r = await send(body());
    expect(r.status).toBe(201);
    expect(r.error).toBeNull();
    expect(signup).toHaveBeenCalledWith(expect.objectContaining({ baaAccepted: true }));
  });

  it("CONTROL — a short password is still the password's refusal, not the BAA's", async () => {
    // Otherwise "422 mentioning the BAA" could be what every malformed body
    // returns, and the refusals above would say nothing about the agreement.
    const r = await send(body({ password: "short" }));
    expect(r.status).toBe(422);
    expect(r.error).toContain("at least 12 characters");
    expect(r.error).not.toContain(BAA_LINE);
    expect(signup).not.toHaveBeenCalled();
  });
});
