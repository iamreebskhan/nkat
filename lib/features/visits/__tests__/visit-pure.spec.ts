import { describe, expect, it } from "vitest";

import {
  canTransition,
  computeTotalMinutes,
  daysRemainingInMedicareWindow,
  isInsideMedicareWindow,
  nextStatuses,
} from "../visit-pure";

describe("computeTotalMinutes", () => {
  it("rounds 29:59 down to 29", () => {
    const start = new Date("2026-05-01T10:00:00Z");
    const stop = new Date("2026-05-01T10:29:59Z");
    expect(computeTotalMinutes(start, stop)).toBe(29);
  });

  it("returns null when either timestamp is missing", () => {
    expect(computeTotalMinutes(null, new Date())).toBeNull();
    expect(computeTotalMinutes(new Date(), null)).toBeNull();
    expect(computeTotalMinutes(undefined, undefined)).toBeNull();
  });

  it("returns null when stop precedes start", () => {
    const start = new Date("2026-05-01T11:00:00Z");
    const stop = new Date("2026-05-01T10:00:00Z");
    expect(computeTotalMinutes(start, stop)).toBeNull();
  });

  it("zero-duration visits are 0", () => {
    const t = new Date();
    expect(computeTotalMinutes(t, t)).toBe(0);
  });
});

describe("status transitions", () => {
  it("scheduled → in_progress | cancelled | no_show", () => {
    expect(canTransition("scheduled", "in_progress")).toBe(true);
    expect(canTransition("scheduled", "cancelled")).toBe(true);
    expect(canTransition("scheduled", "no_show")).toBe(true);
    expect(canTransition("scheduled", "documented")).toBe(false);
  });

  it("in_progress → documented | cancelled", () => {
    expect(canTransition("in_progress", "documented")).toBe(true);
    expect(canTransition("in_progress", "cancelled")).toBe(true);
    expect(canTransition("in_progress", "billed")).toBe(false);
  });

  it("billed is terminal", () => {
    expect(nextStatuses("billed")).toEqual([]);
    expect(canTransition("billed", "documented")).toBe(false);
  });

  it("cancelled and no_show are terminal", () => {
    expect(nextStatuses("cancelled")).toEqual([]);
    expect(nextStatuses("no_show")).toEqual([]);
  });
});

describe("Medicare 11-day window", () => {
  const dos = new Date("2026-05-15T12:00:00Z");

  it("inside window 3 days before DOS", () => {
    const today = new Date("2026-05-12T08:00:00Z");
    expect(isInsideMedicareWindow(dos, today)).toBe(true);
  });

  it("inside window day-of", () => {
    const today = new Date("2026-05-15T08:00:00Z");
    expect(isInsideMedicareWindow(dos, today)).toBe(true);
  });

  it("inside window 7 days after DOS", () => {
    const today = new Date("2026-05-22T20:00:00Z");
    expect(isInsideMedicareWindow(dos, today)).toBe(true);
  });

  it("outside window 4 days before DOS", () => {
    const today = new Date("2026-05-11T08:00:00Z");
    expect(isInsideMedicareWindow(dos, today)).toBe(false);
  });

  it("outside window 8 days after DOS", () => {
    const today = new Date("2026-05-23T08:00:00Z");
    expect(isInsideMedicareWindow(dos, today)).toBe(false);
  });

  it("daysRemaining shrinks as we approach the deadline", () => {
    expect(daysRemainingInMedicareWindow(dos, new Date("2026-05-15T08:00:00Z"))).toBe(7);
    expect(daysRemainingInMedicareWindow(dos, new Date("2026-05-19T08:00:00Z"))).toBe(3);
    expect(daysRemainingInMedicareWindow(dos, new Date("2026-05-22T08:00:00Z"))).toBe(0);
  });

  it("daysRemaining is 0 outside the window", () => {
    expect(daysRemainingInMedicareWindow(dos, new Date("2026-05-23T08:00:00Z"))).toBe(0);
    expect(daysRemainingInMedicareWindow(dos, new Date("2026-05-11T08:00:00Z"))).toBe(0);
  });
});
