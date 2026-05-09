import { describe, expect, it } from "vitest";

import {
  DEFAULT_ATTESTATION_DAYS,
  daysUntilExpiry,
  defaultExpiry,
  freshnessBucket,
  groupByFreshness,
  shouldRemindToday,
} from "../attestation-pure";

describe("defaultExpiry", () => {
  it("adds 90 days to call_date", () => {
    const d = defaultExpiry("2026-01-01T00:00:00Z");
    expect(d.toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(DEFAULT_ATTESTATION_DAYS).toBe(90);
  });
});

describe("daysUntilExpiry", () => {
  it("positive when in the future", () => {
    const today = new Date("2026-05-01T08:00:00Z");
    expect(daysUntilExpiry("2026-05-15T00:00:00Z", today)).toBe(14);
  });

  it("zero on the day of expiry (UTC)", () => {
    const today = new Date("2026-05-15T20:00:00Z");
    expect(daysUntilExpiry("2026-05-15T00:00:00Z", today)).toBe(0);
  });

  it("negative when past", () => {
    const today = new Date("2026-06-01T00:00:00Z");
    expect(daysUntilExpiry("2026-05-15T00:00:00Z", today)).toBe(-17);
  });
});

describe("freshnessBucket", () => {
  const today = new Date("2026-05-01T00:00:00Z");

  it("'overdue' for non-active rows regardless of date", () => {
    expect(
      freshnessBucket(
        { status: "voided", expiresAt: "2026-12-01T00:00:00Z" },
        today,
      ),
    ).toBe("overdue");
    expect(
      freshnessBucket(
        { status: "expired", expiresAt: "2026-12-01T00:00:00Z" },
        today,
      ),
    ).toBe("overdue");
  });

  it("'due' for active with ≤7 days remaining", () => {
    expect(
      freshnessBucket(
        { status: "active", expiresAt: "2026-05-05T00:00:00Z" },
        today,
      ),
    ).toBe("due");
  });

  it("'expiring_soon' for ≤30 but >7 days remaining", () => {
    expect(
      freshnessBucket(
        { status: "active", expiresAt: "2026-05-25T00:00:00Z" },
        today,
      ),
    ).toBe("expiring_soon");
  });

  it("'fresh' for >30 days remaining", () => {
    expect(
      freshnessBucket(
        { status: "active", expiresAt: "2026-07-01T00:00:00Z" },
        today,
      ),
    ).toBe("fresh");
  });

  it("'overdue' for active rows past expiry", () => {
    expect(
      freshnessBucket(
        { status: "active", expiresAt: "2026-04-01T00:00:00Z" },
        today,
      ),
    ).toBe("overdue");
  });
});

describe("shouldRemindToday (75/85/90-day schedule per §15.3)", () => {
  const callDate = new Date("2026-01-01T00:00:00Z");
  const expires = defaultExpiry(callDate);

  it("fires at call_date + 75 days (15 remaining)", () => {
    const today = new Date("2026-03-17T00:00:00Z"); // 1 Jan + 75 days = 17 Mar
    expect(daysUntilExpiry(expires, today)).toBe(15);
    expect(
      shouldRemindToday({ status: "active", expiresAt: expires }, today),
    ).toBe(true);
  });

  it("fires at call_date + 85 days (5 remaining)", () => {
    const today = new Date("2026-03-27T00:00:00Z"); // 1 Jan + 85 days
    expect(daysUntilExpiry(expires, today)).toBe(5);
    expect(
      shouldRemindToday({ status: "active", expiresAt: expires }, today),
    ).toBe(true);
  });

  it("fires at call_date + 90 days (0 remaining)", () => {
    const today = new Date("2026-04-01T00:00:00Z");
    expect(daysUntilExpiry(expires, today)).toBe(0);
    expect(
      shouldRemindToday({ status: "active", expiresAt: expires }, today),
    ).toBe(true);
  });

  it("silent on non-reminder days", () => {
    const today = new Date("2026-03-15T00:00:00Z"); // not 75/85/90
    expect(
      shouldRemindToday({ status: "active", expiresAt: expires }, today),
    ).toBe(false);
  });

  it("silent for non-active rows", () => {
    const today = new Date("2026-03-17T00:00:00Z"); // would be 75-day
    expect(
      shouldRemindToday({ status: "voided", expiresAt: expires }, today),
    ).toBe(false);
  });
});

describe("groupByFreshness", () => {
  const today = new Date("2026-05-01T00:00:00Z");

  it("partitions a mixed list", () => {
    const rows = [
      { status: "active" as const, expiresAt: "2026-07-01T00:00:00Z" }, // fresh
      { status: "active" as const, expiresAt: "2026-05-25T00:00:00Z" }, // expiring_soon
      { status: "active" as const, expiresAt: "2026-05-05T00:00:00Z" }, // due
      { status: "active" as const, expiresAt: "2026-04-01T00:00:00Z" }, // overdue
      { status: "voided" as const, expiresAt: "2026-08-01T00:00:00Z" }, // overdue
    ];
    const g = groupByFreshness(rows, today);
    expect(g.fresh).toHaveLength(1);
    expect(g.expiring_soon).toHaveLength(1);
    expect(g.due).toHaveLength(1);
    expect(g.overdue).toHaveLength(2);
  });
});
