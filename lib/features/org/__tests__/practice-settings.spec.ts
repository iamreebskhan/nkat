/**
 * The practice's time zone and daily visit cap, set from Settings → Practice.
 *
 * Both were columns with defaults and no screen (live test 2026-10-22). The
 * write names the org, audits the fields that changed (and nothing when none
 * did), and refuses a zone the database's CHECK (0107) would refuse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { PracticeSettingsSchema, updatePracticeSettings } from "../practice-settings.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let row: { timezone: string; daily_visit_capacity: number };
let calls: { sql: string; values: unknown[] }[];

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  row = { timezone: "America/New_York", daily_visit_capacity: 8 };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("¶");
        calls.push({ sql, values });
        if (sql.includes("UPDATE org")) {
          row = { timezone: values[0] as string, daily_visit_capacity: values[1] as number };
          return Promise.resolve([row]);
        }
        if (sql.includes("FROM org")) return Promise.resolve([{ ...row }]);
        return Promise.resolve([]);
      },
    }),
  );
});

describe("updatePracticeSettings", () => {
  it("sets both, on the caller's org, and audits the fields that changed", async () => {
    const v = await updatePracticeSettings({
      orgId: ORG,
      payload: { timezone: "America/Chicago", dailyVisitCapacity: 10 },
      actorUserId: USER,
    });
    expect(v).toEqual({ timezone: "America/Chicago", dailyVisitCapacity: 10 });
    const update = calls.find((c) => c.sql.includes("UPDATE org"))!;
    expect(update.sql).toContain("WHERE id = ");
    expect(update.values).toContain(ORG);
    expect(vi.mocked(writeAudit).mock.calls[0]![1]).toMatchObject({
      action: "settings_update",
      targetType: "practice",
      userId: USER,
      payload: { change: "edit", fields: ["dailyVisitCapacity", "timezone"] },
    });
  });

  it("names only the field that changed", async () => {
    await updatePracticeSettings({ orgId: ORG, payload: { timezone: "America/New_York", dailyVisitCapacity: 12 } });
    expect(vi.mocked(writeAudit).mock.calls[0]![1].payload).toEqual({ change: "edit", fields: ["dailyVisitCapacity"] });
  });

  it("writes no audit row when nothing changed", async () => {
    await updatePracticeSettings({ orgId: ORG, payload: { timezone: "America/New_York", dailyVisitCapacity: 8 } });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("PracticeSettingsSchema", () => {
  it("takes the eight zones 0107 allows", () => {
    expect(PracticeSettingsSchema.safeParse({ timezone: "Pacific/Honolulu", dailyVisitCapacity: 6 }).success).toBe(true);
  });

  it.each([
    [{ timezone: "Europe/London", dailyVisitCapacity: 8 }],
    [{ timezone: "America/New_York", dailyVisitCapacity: 0 }],
    [{ timezone: "America/New_York", dailyVisitCapacity: 31 }],
    [{ timezone: "America/New_York", dailyVisitCapacity: 7.5 }],
  ])("refuses %j", (body) => {
    expect(PracticeSettingsSchema.safeParse(body).success).toBe(false);
  });
});
