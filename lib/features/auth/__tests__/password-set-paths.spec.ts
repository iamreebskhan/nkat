/**
 * The other two ways to set a password, run against the REAL policy.
 *
 * password-policy.ts exists because all three password-setting paths carried
 * their own bare `length < 12` and nothing else, so "aaaaaaaaaaaa" protected
 * accounts holding PHI. signup is pinned next door in signup-guards.spec.ts;
 * these two had no spec of any kind, which means the shared policy could be
 * dropped from either of them and the suite would stay green — and a rule that
 * only guards the front door is not a rule, since rotating or resetting is the
 * other way to choose a password.
 *
 * Nothing here mocks @/lib/features/auth/password-policy: the real rules run
 * and the reasons asserted are the policy's own. Only the database and bcrypt
 * are stood in for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    $executeRaw: h.executeRaw,
    $transaction: h.transaction,
  },
  withOrgContext: vi.fn(),
  withBreakglass: vi.fn(),
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed"), compare: vi.fn().mockResolvedValue(true) },
}));

import { changePassword } from "../change-password.service";
import { confirmReset } from "../password-reset.service";
import { checkPassword } from "../password-policy";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Long, unguessable, not a pattern the policy screens for. */
const GOOD = "quiet-harbor-lantern-49";

/** Each is 12+ characters, so a bare length rule would let it through. */
const WEAK = [
  ["twelve identical characters", "aaaaaaaaaaaa"],
  ["a straight alphabetical run", "abcdefghijklm"],
  ["all digits", "195024081973"],
  ["a padded common base", "passwordpassword"],
  ["a leet-padded common base", "p@ssw0rd1234"],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.queryRaw.mockResolvedValue([{ id: USER, password_hash: "$2a$12$hash" }]);
  h.executeRaw.mockResolvedValue(1);
  h.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $queryRaw: () =>
        Promise.resolve([
          {
            id: "tok",
            user_id: USER,
            email: "owner@riverside-pall.test",
            expires_at: new Date(Date.now() + 60_000),
            redeemed_at: null,
          },
        ]),
      $executeRaw: h.executeRaw,
    }),
  );
});

describe("changePassword — the shared policy, run for real", () => {
  for (const [label, password] of WEAK) {
    it(`refuses ${label} and never reads the account`, async () => {
      const verdict = checkPassword(password);
      expect(verdict.ok).toBe(false);
      const reason = verdict.ok ? undefined : verdict.reason;

      expect(
        await changePassword({ userId: USER, currentPassword: "old", newPassword: password }),
      ).toEqual({ error: "weak_password", reason });
      // Refused before the current password is even looked up, so the refusal
      // cannot be something that happened later.
      expect(h.queryRaw).not.toHaveBeenCalled();
      expect(h.executeRaw).not.toHaveBeenCalled();
    });
  }

  it("CONTROL — a strong password is accepted and the hash is written", async () => {
    // Without this the refusals above would be satisfied by a service that
    // refuses every password.
    expect(
      await changePassword({ userId: USER, currentPassword: "old", newPassword: GOOD }),
    ).toEqual({ ok: true });
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("confirmReset — the shared policy, run for real", () => {
  for (const [label, password] of WEAK) {
    it(`refuses ${label} and never redeems the token`, async () => {
      const verdict = checkPassword(password);
      expect(verdict.ok).toBe(false);
      const reason = verdict.ok ? undefined : verdict.reason;

      expect(await confirmReset({ rawToken: "t".repeat(64), newPassword: password })).toEqual({
        error: "weak_password",
        reason,
      });
      // A refused reset must leave the token unspent: the user still has one.
      expect(h.transaction).not.toHaveBeenCalled();
    });
  }

  it("CONTROL — a strong password redeems the token and swaps the hash", async () => {
    const r = await confirmReset({ rawToken: "t".repeat(64), newPassword: GOOD });
    expect(r).toEqual({ userId: USER, email: "owner@riverside-pall.test" });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });
});
