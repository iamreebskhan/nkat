/**
 * A new authenticator waits as the PENDING secret until its first code (0121).
 *
 * Setup used to overwrite mfa_secret and clear mfa_enrolled_at, so starting a
 * setup and walking away — or a stolen session starting one — left the
 * account with no second factor at all. The table below is app_user as these
 * statements leave it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ verify: vi.fn() }));

type Row = { mfa_secret: string | null; mfa_enrolled_at: Date | null; mfa_pending_secret: string | null };
let row: Row;
const statements: string[] = [];

function exec(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.join("?");
  statements.push(sql);
  if (/SET mfa_pending_secret = \?/.test(sql) && !/mfa_secret = \?/.test(sql)) row.mfa_pending_secret = values[0] as string;
  else if (/SET mfa_secret = \?, mfa_pending_secret = NULL, mfa_enrolled_at = now\(\)/.test(sql)) {
    row = { mfa_secret: values[0] as string, mfa_pending_secret: null, mfa_enrolled_at: new Date() };
  }
  return Promise.resolve(1);
}

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: () => Promise.resolve([{ ...row }]),
    $executeRaw: exec,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ $executeRaw: exec }),
  },
}));
vi.mock("../totp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../totp")>()),
  verifyTotp: h.verify,
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("hash") } }));

import { confirmMfaSetup, setupMfa } from "../mfa.service";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENROLLED_AT = new Date("2026-05-01T00:00:00Z");

beforeEach(() => {
  statements.length = 0;
  h.verify.mockReset();
});

describe("setupMfa", () => {
  it("keeps the enrolled authenticator in force while a new one is set up", async () => {
    row = { mfa_secret: "OLDSECRET", mfa_enrolled_at: ENROLLED_AT, mfa_pending_secret: null };
    const r = await setupMfa({ userId: USER, email: "a@example.test" });
    expect(row.mfa_secret).toBe("OLDSECRET");
    expect(row.mfa_enrolled_at).toBe(ENROLLED_AT);
    expect(row.mfa_pending_secret).toBe(r.secretBase32);
    expect(statements.join("\n")).not.toMatch(/mfa_enrolled_at = NULL/);
  });
});

describe("confirmMfaSetup", () => {
  it("checks the code against the NEW authenticator and makes it the one", async () => {
    row = { mfa_secret: "OLDSECRET", mfa_enrolled_at: ENROLLED_AT, mfa_pending_secret: "NEWSECRET" };
    h.verify.mockImplementation((secret: string) => secret === "NEWSECRET");
    const r = await confirmMfaSetup({ userId: USER, code: "123456" });
    expect("confirmed" in r).toBe(true);
    expect(row).toMatchObject({ mfa_secret: "NEWSECRET", mfa_pending_secret: null });
  });

  it("CONTROL — a code from the OLD authenticator does not confirm the new one", async () => {
    row = { mfa_secret: "OLDSECRET", mfa_enrolled_at: ENROLLED_AT, mfa_pending_secret: "NEWSECRET" };
    h.verify.mockImplementation((secret: string) => secret === "OLDSECRET");
    expect(await confirmMfaSetup({ userId: USER, code: "123456" })).toEqual({ error: "bad_code" });
    expect(row.mfa_secret).toBe("OLDSECRET");
  });

  it("confirms a setup started before 0121 (secret written, no date)", async () => {
    row = { mfa_secret: "LEGACY", mfa_enrolled_at: null, mfa_pending_secret: null };
    h.verify.mockImplementation((secret: string) => secret === "LEGACY");
    expect("confirmed" in (await confirmMfaSetup({ userId: USER, code: "123456" }))).toBe(true);
  });

  it("has nothing to confirm on an enrolled account with no setup under way", async () => {
    row = { mfa_secret: "OLDSECRET", mfa_enrolled_at: ENROLLED_AT, mfa_pending_secret: null };
    h.verify.mockReturnValue(true);
    expect(await confirmMfaSetup({ userId: USER, code: "123456" })).toEqual({ error: "no_pending_setup" });
  });
});
