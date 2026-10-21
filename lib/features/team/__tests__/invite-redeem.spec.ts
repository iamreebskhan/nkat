/**
 * Redeeming an invite gives the member the template they were invited with
 * (audit R38). The membership used to be 'employee' whatever the invite said,
 * and login mapped that to clinician.
 *
 * lib/db is mocked; the tenant transaction is a fake dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn() },
  withBreakglass: vi.fn(),
  withOrgContext: vi.fn(),
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("hashed") } }));

import { prisma, withBreakglass, withOrgContext } from "@/lib/db";

import { redeemInvite } from "../invite-redeem.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let invite: Record<string, unknown>;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("¶"), values });
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const memberInsert = () => calls.find((c) => c.sql.includes("INSERT INTO org_member"))!;

beforeEach(() => {
  calls = [];
  invite = {
    id: "i1", org_id: ORG, email: "analyst@local.test",
    expires_at: new Date(Date.now() + 3_600_000), redeemed_at: null, role_template: "analyst",
  };
  vi.mocked(withBreakglass).mockImplementation((async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: () => Promise.resolve([invite]) })) as never);
  // An existing account, so no password is needed.
  (prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: USER, password_hash: "x" },
  ]);
  vi.mocked(withOrgContext).mockImplementation((async (_o: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(fakeTx())) as never);
});

describe("redeemInvite — the invited role (audit R38)", () => {
  it("puts the invite's template on the membership, and returns it for the session", async () => {
    const r = await redeemInvite({ token: "t", fullName: "A", password: undefined });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.roleTemplate).toBe("analyst");
    expect(memberInsert().sql).toContain("role_template");
    expect(memberInsert().values).toContain("analyst");
  });

  it("keeps a billing agent a billing agent", async () => {
    invite = { ...invite, role_template: "billing_agent" };
    const r = await redeemInvite({ token: "t", fullName: "A", password: undefined });
    if ("error" in r) throw new Error("unexpected error");
    expect(r.roleTemplate).toBe("billing_agent");
  });

  it("falls back to the legacy mapping for a template that is not one of ours", async () => {
    invite = { ...invite, role_template: "bogus" };
    const r = await redeemInvite({ token: "t", fullName: "A", password: undefined });
    if ("error" in r) throw new Error("unexpected error");
    expect(r.roleTemplate).toBe("clinician");
  });

  it("refuses an expired invite and writes nothing", async () => {
    invite = { ...invite, expires_at: new Date(Date.now() - 1000) };
    const r = await redeemInvite({ token: "t", fullName: "A", password: undefined });
    expect(r).toEqual({ error: "expired_or_invalid" });
    expect(calls).toHaveLength(0);
  });
});
