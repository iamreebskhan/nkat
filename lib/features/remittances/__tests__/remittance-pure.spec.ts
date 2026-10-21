/**
 * What a payer's 835 says happened to a claim, and the status steps that
 * follow in Pallio (audit R10).
 *
 * lib/db is mocked only because STATUS_TRANSITIONS lives in the superbill
 * service: every plan here is held to that same map.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import {
  STATUS_TRANSITIONS,
  SUPERBILL_STATUSES,
  type SuperbillStatus,
} from "@/lib/features/superbills/superbill.service";

import { parseEra835 } from "../era835-parser";
import type { Era835Claim, Era835ServiceLine } from "../era835-types";
import { classifyClaim, planPosting, staleAgainstRefile } from "../remittance-pure";

const fixture = (name: string) =>
  parseEra835(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const line = (o: Partial<Era835ServiceLine> = {}): Era835ServiceLine => ({
  service_code: "99344",
  modifiers: [],
  billed_amount: 100,
  paid_amount: 100,
  units: 1,
  adjustments: [],
  rarc_codes: [],
  ...o,
});

const claim = (o: Partial<Era835Claim> = {}): Era835Claim => ({
  claim_id: "B2E303AFE2CB",
  status_code: "1",
  billed_amount: 200,
  paid_amount: 200,
  adjustments: [],
  rarc_codes: [],
  service_lines: [],
  ...o,
});

describe("classifyClaim — the ported fixture", () => {
  const [c1, c2, c3] = fixture("sample-835.txt").claims;

  it("CLAIM-001 is paid, 20000 cents", () => {
    const v = classifyClaim(c1!);
    expect(v.outcome).toBe("paid");
    expect(v.paidCents).toBe(20000);
    expect(v.deniedLines).toEqual([]);
  });

  it("CLAIM-002 (CLP02 4, CO-97) is denied with CARC 97, group CO, and the line's RARC", () => {
    const v = classifyClaim(c2!);
    expect(v.outcome).toBe("denied");
    expect(v.deniedLines).toEqual([
      { code: "36415", carc: "97", rarc: "N56", group: "CO", amountCents: 15000 },
    ]);
  });

  it("CLAIM-003 (paid 0, CO-29 at claim level) is denied with CARC 29", () => {
    const v = classifyClaim(c3!);
    expect(v.outcome).toBe("denied");
    expect(v.deniedLines[0]!.carc).toBe("29");
    expect(v.deniedLines[0]!.group).toBe("CO");
  });
});

describe("classifyClaim — the live-test files", () => {
  it("deny.835 denies B2E303AFE2CB with CARC 16, group CO, RARC M51", () => {
    const [c] = fixture("deny.835").claims;
    const v = classifyClaim(c!);
    expect(v.outcome).toBe("denied");
    expect(v.deniedLines).toEqual([
      { code: "99344", carc: "16", rarc: "M51", group: "CO", amountCents: 11401 },
    ]);
  });

  it("pay.835 pays $98.50 on B2E303AFE2CB (CO-45 is the allowed amount, not a denial) and $50 on the other", () => {
    const [a, b] = fixture("pay.835").claims;
    expect(classifyClaim(a!)).toMatchObject({ outcome: "paid", paidCents: 9850, deniedLines: [] });
    expect(classifyClaim(b!)).toMatchObject({ outcome: "paid", paidCents: 5000 });
  });
});

describe("classifyClaim — what is not plainly a payment or a denial", () => {
  it("sends a reversal (CLP02 22) to review", () => {
    const v = classifyClaim(claim({ status_code: "22", paid_amount: -98.5 }));
    expect(v.outcome).toBe("needs_review");
    expect(v.note).toMatch(/reversed/);
  });

  it("sends a claim paid $0 with only patient responsibility (PR) to review — it is not a denial", () => {
    const v = classifyClaim(
      claim({
        paid_amount: 0,
        adjustments: [{ group_code: "PR", reason_code: "1", amount: 200 }],
        service_lines: [line({ paid_amount: 0, adjustments: [{ group_code: "PR", reason_code: "1", amount: 100 }] })],
      }),
    );
    expect(v.outcome).toBe("needs_review");
    expect(v.deniedLines).toEqual([]);
  });

  it("sends a $0 claim with no adjustment at all, and a negative payment, to review", () => {
    expect(classifyClaim(claim({ paid_amount: 0 })).outcome).toBe("needs_review");
    expect(classifyClaim(claim({ status_code: "1", paid_amount: -10 })).outcome).toBe("needs_review");
  });

  it("calls a two-line claim with one $0 line carrying CO-97 partially paid, denying only that line", () => {
    const v = classifyClaim(
      claim({
        billed_amount: 250,
        paid_amount: 150,
        service_lines: [
          line({ service_code: "99349", billed_amount: 150, paid_amount: 150 }),
          line({
            service_code: "99497",
            billed_amount: 100,
            paid_amount: 0,
            adjustments: [{ group_code: "CO", reason_code: "97", amount: 100 }],
          }),
        ],
      }),
    );
    expect(v.outcome).toBe("partially_paid");
    expect(v.paidCents).toBe(15000);
    expect(v.deniedLines).toEqual([
      { code: "99497", carc: "97", rarc: null, group: "CO", amountCents: 10000 },
    ]);
  });

  it("CONTROL — a $0 line the payer passed to the patient (PR only) does not make the claim partial", () => {
    const v = classifyClaim(
      claim({
        paid_amount: 150,
        service_lines: [
          line({ paid_amount: 150 }),
          line({ paid_amount: 0, adjustments: [{ group_code: "PR", reason_code: "1", amount: 100 }] }),
        ],
      }),
    );
    expect(v.outcome).toBe("paid");
  });

  it("takes the CARC from the first non-PR adjustment, line before claim", () => {
    const v = classifyClaim(
      claim({
        status_code: "4",
        paid_amount: 0,
        adjustments: [{ group_code: "OA", reason_code: "18", amount: 100 }],
        service_lines: [
          line({
            paid_amount: 0,
            adjustments: [
              { group_code: "PR", reason_code: "1", amount: 20 },
              { group_code: "CO", reason_code: "50", amount: 80 },
            ],
          }),
          line({ service_code: "99497", paid_amount: 0 }),
        ],
      }),
    );
    expect(v.deniedLines.map((l) => [l.code, l.carc, l.group])).toEqual([
      ["99344", "50", "CO"],
      ["99497", "18", "OA"],
    ]);
  });
});

describe("planPosting", () => {
  it("posts straight onto a submitted bill", () => {
    expect(planPosting("submitted", "paid", true)).toEqual({ steps: ["paid"] });
    expect(planPosting("submitted", "partially_paid", true)).toEqual({ steps: ["partially_paid"] });
    expect(planPosting("submitted", "denied", true)).toEqual({ steps: ["denied"] });
  });

  it("steps a reviewed or denied bill through submitted: the payer processing it proves it went out", () => {
    expect(planPosting("ready_to_submit", "paid", true)).toEqual({ steps: ["submitted", "paid"] });
    expect(planPosting("denied", "paid", true)).toEqual({ steps: ["submitted", "paid"] });
    expect(planPosting("denied", "partially_paid", true)).toEqual({ steps: ["submitted", "partially_paid"] });
  });

  it("sends a DRAFT to review rather than stepping it through a review nobody did (audit R26)", () => {
    for (const outcome of ["paid", "partially_paid", "denied"] as const) {
      const p = planPosting("draft", outcome, true);
      expect(p).toHaveProperty("needsReview");
      expect((p as { needsReview: string }).needsReview).toMatch(/still a draft/);
    }
  });

  it("will not record a bill with no rendering-provider NPI as submitted (audit R40)", () => {
    const p = planPosting("denied", "paid", false);
    expect((p as { needsReview: string }).needsReview).toMatch(/no rendering-provider NPI/);
    expect(planPosting("ready_to_submit", "denied", false)).toHaveProperty("needsReview");
  });

  it("CONTROL — a missing NPI does not stop posting to a bill already submitted", () => {
    expect(planPosting("submitted", "paid", false)).toEqual({ steps: ["paid"] });
  });

  it("leaves a settled bill alone", () => {
    expect(planPosting("paid", "paid", true)).toHaveProperty("needsReview");
    expect(planPosting("voided", "denied", true)).toHaveProperty("needsReview");
  });

  it("fills in only the reason when a denied bill is denied again", () => {
    expect(planPosting("denied", "denied", true)).toEqual({ steps: [] });
    // No status step, so the NPI does not matter.
    expect(planPosting("denied", "denied", false)).toEqual({ steps: [] });
  });

  it("handles a partially paid bill", () => {
    // Changed on purpose (review finding): a full payment on a partially paid
    // bill goes to review too, because posting 'paid' would overwrite the
    // partial amount already recorded.
    expect(planPosting("partially_paid", "paid", true)).toHaveProperty("needsReview");
    expect(planPosting("partially_paid", "denied", true)).toEqual({ steps: ["denied"] });
    expect(planPosting("partially_paid", "partially_paid", true)).toHaveProperty("needsReview");
  });

  it("never plans a move the transition map forbids, from any status", () => {
    for (const status of SUPERBILL_STATUSES) {
      for (const outcome of ["paid", "partially_paid", "denied"] as const) {
        for (const hasNpi of [true, false]) {
          const p = planPosting(status, outcome, hasNpi);
          if (!("steps" in p)) continue;
          let from: SuperbillStatus = status;
          for (const to of p.steps) {
            expect(STATUS_TRANSITIONS[from], `${status} → ${outcome}: ${from} → ${to}`).toContain(to);
            from = to;
          }
          if (p.steps.length > 0) expect(from).toBe(outcome);
        }
      }
    }
  });
});

describe("planPosting — a payment on a partially paid bill", () => {
  it("holds a 'paid' remittance for review: its CLP04 would replace the partial payment already recorded", () => {
    const p = planPosting("partially_paid", "paid", true);
    expect((p as { needsReview: string }).needsReview).toMatch(/partial payment is already recorded/);
  });

  it("CONTROL — a submitted bill paid in full still posts", () => {
    expect(planPosting("submitted", "paid", true)).toEqual({ steps: ["paid"] });
  });
});

describe("staleAgainstRefile", () => {
  const REFILED = new Date("2026-09-15T03:41:34Z");

  it("holds a file dated before the latest refile", () => {
    expect(staleAgainstRefile("2026-09-14", REFILED)).toMatch(
      /^This remittance is dated 2026-09-14, on or before this claim was refiled \(2026-09-15\)/,
    );
  });

  it("holds a file dated on the refile day itself", () => {
    expect(staleAgainstRefile("2026-09-15", REFILED)).not.toBeNull();
  });

  it("takes the refile's date in UTC, so a US evening refile counts as the next day", () => {
    // 21:00 on 14 September in New York is 01:00 on 15 September UTC.
    expect(staleAgainstRefile("2026-09-15", new Date("2026-09-15T01:00:00Z"))).not.toBeNull();
  });

  it("holds a refiled bill's file that carries no payment date", () => {
    expect(staleAgainstRefile(null, REFILED)).toMatch(/no payment date \(BPR16\)/);
  });

  it("CONTROL — a file dated after the refile posts", () => {
    expect(staleAgainstRefile("2026-09-16", REFILED)).toBeNull();
  });

  it("CONTROL — a bill never refiled posts, with or without a payment date", () => {
    expect(staleAgainstRefile("2026-09-14", null)).toBeNull();
    expect(staleAgainstRefile(null, null)).toBeNull();
  });
});
