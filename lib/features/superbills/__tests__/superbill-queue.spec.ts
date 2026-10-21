/**
 * The queue's statuses, labels and actions (audit R26), in the recorded voice
 * (audit R35). The actions' legality against the service's transition map is
 * in superbill-actions.spec.ts, which needs lib/db mocked.
 */
import { describe, expect, it } from "vitest";

import {
  QUEUE_ACTIONS,
  paidInFullConfirmText,
  parseStatusParam,
  statusLabel,
} from "../superbill-queue";

describe("parseStatusParam", () => {
  it("reads a valid status from the query string", () => {
    expect(parseStatusParam("?status=ready_to_submit")).toBe("ready_to_submit");
    expect(parseStatusParam("?status=draft&x=1")).toBe("draft");
  });

  it("falls back to 'all' for a missing or unknown status", () => {
    expect(parseStatusParam("")).toBe("all");
    expect(parseStatusParam("?status=bogus")).toBe("all");
    expect(parseStatusParam("?other=draft")).toBe("all");
  });
});

describe("statusLabel", () => {
  it("replaces every underscore — it used to render 'ready to_submit'", () => {
    expect(statusLabel("ready_to_submit")).toBe("ready to submit");
    expect(statusLabel("partially_paid")).toBe("partially paid");
    expect(statusLabel("draft")).toBe("draft");
  });
});

describe("QUEUE_ACTIONS", () => {
  it("offers no one-click path from a draft to submitted — review cannot be skipped", () => {
    expect(QUEUE_ACTIONS.draft).toEqual([]);
    expect(QUEUE_ACTIONS.draft!.some((a) => a.to === "submitted")).toBe(false);
  });

  it("submits a reviewed bill, and refiles a denied one in one step", () => {
    expect(QUEUE_ACTIONS.ready_to_submit!.map((a) => a.to)).toEqual(["submitted"]);
    expect(QUEUE_ACTIONS.denied!.map((a) => a.to)).toEqual(["submitted"]);
  });

  it("never voids from a button", () => {
    for (const actions of Object.values(QUEUE_ACTIONS)) {
      expect(actions.some((a) => a.to === "voided")).toBe(false);
    }
  });

  it("names each step as something recorded, not something the click did (audit R35)", () => {
    const labels = (s: string) => QUEUE_ACTIONS[s]!.map((a) => a.label);
    expect(labels("ready_to_submit")).toEqual(["Record as submitted"]);
    expect(labels("submitted")).toEqual([
      "Record paid in full",
      "Record partial payment",
      "Record denial",
    ]);
    expect(labels("partially_paid")).toEqual(["Record paid in full"]);
    expect(labels("denied")).toEqual(["Record resubmission"]);
  });

  it("only a move to paid writes the billed amount; only a partial payment asks for one", () => {
    for (const a of Object.values(QUEUE_ACTIONS).flat()) {
      if (a.amount === "billed") expect(a.to).toBe("paid");
      if (a.amount === "prompt") expect(a.to).toBe("partially_paid");
      if (a.to === "paid") expect(a.amount).toBe("billed");
      if (a.to === "partially_paid") expect(a.amount).toBe("prompt");
    }
  });
});

describe("paidInFullConfirmText (audit R35)", () => {
  // "Record paid in full" writes paid = billed. It asks first, naming the
  // amount, and says what should be in front of the biller before saying yes.
  it("names the amount it will record and asks for the EOB behind it", () => {
    const t = paidInFullConfirmText(11401);
    expect(t).toContain("$114.01");
    expect(t).toMatch(/full billed amount/);
    expect(t).toMatch(/EOB or remittance/);
  });
});
