/**
 * The practice's sign-in rules (0121): what may be saved, and what the audit
 * trail says when they change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ audit: vi.fn(), before: { idle_timeout_minutes: 30, mfa_policy: "admins_and_billers" } }));

vi.mock("@/lib/db", () => ({
  withOrgContext: async (_o: string, fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("FOR UPDATE")) return Promise.resolve([h.before]);
        if (sql.includes("UPDATE org")) return Promise.resolve([{ idle_timeout_minutes: values[0], mfa_policy: values[1] }]);
        return Promise.resolve([h.before]);
      },
    }),
}));
vi.mock("@/lib/features/audit/audit-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: h.audit,
}));

import { SecuritySettingsSchema, updateSecuritySettings } from "../security-settings.service";

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.audit.mockReset();
  h.before = { idle_timeout_minutes: 30, mfa_policy: "admins_and_billers" };
});

describe("SecuritySettingsSchema", () => {
  it("takes 5 to 120 whole minutes and a known policy", () => {
    expect(SecuritySettingsSchema.safeParse({ idleTimeoutMinutes: 5, mfaPolicy: "everyone" }).success).toBe(true);
    expect(SecuritySettingsSchema.safeParse({ idleTimeoutMinutes: 120, mfaPolicy: "admins_and_billers" }).success).toBe(true);
  });

  it("refuses outside the range with one plain sentence", () => {
    for (const m of [4, 121, 30.5]) {
      const r = SecuritySettingsSchema.safeParse({ idleTimeoutMinutes: m, mfaPolicy: "everyone" });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]!.path).toEqual([]);
        expect(r.error.issues[0]!.message).toMatch(/5 to 120 whole minutes/);
      }
    }
  });

  it("has no 'off' for the second factor", () => {
    expect(SecuritySettingsSchema.safeParse({ idleTimeoutMinutes: 30, mfaPolicy: "off" }).success).toBe(false);
  });
});

describe("updateSecuritySettings", () => {
  it("records which rule changed, by name only", async () => {
    await updateSecuritySettings({ orgId: ORG, payload: { idleTimeoutMinutes: 45, mfaPolicy: "admins_and_billers" }, actorUserId: null });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "settings_update", targetType: "security", payload: { change: "edit", fields: ["idleTimeoutMinutes"] } }),
    );
  });

  it("CONTROL — a save that changes nothing writes no audit row", async () => {
    await updateSecuritySettings({ orgId: ORG, payload: { idleTimeoutMinutes: 30, mfaPolicy: "admins_and_billers" }, actorUserId: null });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
