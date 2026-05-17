/**
 * Seat-limit math. Regression: createInvite never checked the cap, so
 * a solo (1-seat) org could invite unlimited members.
 */
import { describe, expect, it } from "vitest";

import {
  resolveSeatCap,
  seatsForTier,
  wouldExceedSeatCap,
} from "../seat-limit";

describe("seatsForTier", () => {
  it("matches the catalog", () => {
    expect(seatsForTier("solo")).toBe(1);
    expect(seatsForTier("team")).toBe(5);
    expect(seatsForTier("org")).toBe(25);
  });
  it("treats enterprise as uncapped", () => {
    expect(seatsForTier("enterprise")).toBe(Infinity);
  });
});

describe("resolveSeatCap", () => {
  it("prefers an explicit subscription seat count", () => {
    expect(resolveSeatCap({ subscriptionSeats: 12, planTier: "solo" })).toBe(12);
  });
  it("falls back to plan_tier when no subscription", () => {
    expect(resolveSeatCap({ subscriptionSeats: null, planTier: "team" })).toBe(5);
  });
  it("ignores a zero/invalid subscription seat count", () => {
    expect(resolveSeatCap({ subscriptionSeats: 0, planTier: "org" })).toBe(25);
  });
});

describe("wouldExceedSeatCap", () => {
  it("blocks the 2nd occupant on a 1-seat plan", () => {
    expect(
      wouldExceedSeatCap({
        activeMembers: 1,
        outstandingInvites: 0,
        cap: 1,
        reInvitingExisting: false,
      }),
    ).toBe(true);
  });

  it("counts outstanding invites toward usage", () => {
    expect(
      wouldExceedSeatCap({
        activeMembers: 3,
        outstandingInvites: 2,
        cap: 5,
        reInvitingExisting: false,
      }),
    ).toBe(true); // 3 + 2 + 1 = 6 > 5
  });

  it("allows when under cap", () => {
    expect(
      wouldExceedSeatCap({
        activeMembers: 2,
        outstandingInvites: 1,
        cap: 5,
        reInvitingExisting: false,
      }),
    ).toBe(false); // 2 + 1 + 1 = 4 ≤ 5
  });

  it("never blocks a re-invite of an existing member/invite", () => {
    expect(
      wouldExceedSeatCap({
        activeMembers: 1,
        outstandingInvites: 0,
        cap: 1,
        reInvitingExisting: true,
      }),
    ).toBe(false);
  });

  it("never blocks on an uncapped (enterprise) plan", () => {
    expect(
      wouldExceedSeatCap({
        activeMembers: 9999,
        outstandingInvites: 9999,
        cap: Infinity,
        reInvitingExisting: false,
      }),
    ).toBe(false);
  });
});
