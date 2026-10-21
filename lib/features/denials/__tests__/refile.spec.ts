/**
 * Refiling a denied claim from the denials workflow.
 *
 * markRefiled used to stamp superbill_denial.refiled_at and stop. The claim
 * stayed 'denied' and no activity row was written, so a refile done from the
 * screen built for refiling was invisible downstream — while the same refile
 * done from the claims queue, which goes through markStatus, was recorded.
 *
 * The visible cost was the Adjustments card: 'resubmitted' activity is what it
 * counts as a refile, markStatus is the only writer of that kind, and so the
 * refile figure read zero however much refiling happened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/superbills/superbill.service", () => ({
  markStatus: vi.fn(),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { markStatus } from "@/lib/features/superbills/superbill.service";
import { DocumentationIncompleteError } from "@/lib/features/visits/documentation-check";

import { markRefiled } from "../denial.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const DENIAL = "d0000000-0000-4000-8000-000000000001";
const SB = "b2e303af-e2cb-4292-8d00-c35c07423a0d";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** The refile-decided denial's claim, as the lookup returns it. Empty = none matched. */
let returned: { superbill_id: string }[];
/** Whether the claim's history shows it went back out after this denial. */
let resent: { ok: number }[];
let calls: string[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray) => {
    const sql = strings.join("¶");
    calls.push(sql);
    if (sql.includes("SELECT superbill_id FROM superbill_denial")) return Promise.resolve(returned);
    if (sql.includes("a.kind = 'resubmitted'")) return Promise.resolve(resent);
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  returned = [{ superbill_id: SB }];
  resent = [{ ok: 1 }];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
  vi.mocked(markStatus).mockResolvedValue({ from: "denied", to: "submitted" });
});

describe("markRefiled", () => {
  it("stamps the refile on the denial row", async () => {
    await markRefiled({ orgId: ORG, id: DENIAL, actorUserId: USER });
    const upd = calls.find((s) => s.includes("UPDATE superbill_denial"))!;
    expect(upd).toContain("refiled_at = COALESCE(");
    // Only a denial the biller actually decided to refile.
    expect(upd).toContain("AND decision = 'refile'");
    expect(calls.find((s) => s.includes("SELECT superbill_id FROM superbill_denial"))).toContain(
      "AND decision = 'refile'",
    );
  });

  it("sends the CLAIM out again, not just the denial row", async () => {
    // This is the fix. Without it the claim stays 'denied' and no
    // 'resubmitted' activity is ever written.
    await markRefiled({ orgId: ORG, id: DENIAL, actorUserId: USER });
    expect(markStatus).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith({
      orgId: ORG,
      id: SB,
      to: "submitted",
      actorUserId: USER,
    });
  });

  it("names who refiled it on the activity trail", async () => {
    await markRefiled({ orgId: ORG, id: DENIAL, actorUserId: USER });
    expect(vi.mocked(markStatus).mock.calls[0]![0].actorUserId).toBe(USER);
  });

  it("404s when no refile-decided denial matched, and moves no claim", async () => {
    // Refiling a denial nobody decided to refile would put a claim back in
    // flight without a decision on record.
    returned = [];
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toThrow(
      /no denial marked for refile/i,
    );
    expect(markStatus).not.toHaveBeenCalled();
  });

  it("keeps the refile record when the claim was already moved from the queue", async () => {
    // The claims queue may have sent it out first. The claim is then not
    // 'denied', markStatus refuses the move — and that is fine: the refile
    // on the denial row still stands and the resubmission is already logged.
    vi.mocked(markStatus).mockRejectedValueOnce(
      new ValidationError("Illegal superbill transition submitted → submitted."),
    );
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).resolves.toBeUndefined();
  });

  it("does not swallow anything other than an illegal transition", async () => {
    // A database failure must surface; only the expected race is tolerated.
    vi.mocked(markStatus).mockRejectedValueOnce(new Error("connection reset"));
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toThrow(/connection reset/);
  });
});

describe("markRefiled — refusals that must surface", () => {
  it("does not swallow a refusal other than the queue race", async () => {
    // A blank rendering NPI stops the claim going out. Swallowing that here
    // would leave a refile recorded on a claim that never left.
    vi.mocked(markStatus).mockRejectedValueOnce(
      new ValidationError("This claim has no rendering-provider NPI, so a payer would reject it."),
    );
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toThrow(/rendering-provider NPI/);
  });
});

describe("markRefiled — the claim goes out before the refile is recorded", () => {
  const stamped = () => calls.some((s) => s.includes("UPDATE superbill_denial"));

  it("records no refile when the claim is refused", async () => {
    vi.mocked(markStatus).mockRejectedValueOnce(
      new ValidationError("This claim has no rendering-provider NPI, so a payer would reject it."),
    );
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toThrow();
    expect(stamped()).toBe(false);
  });

  it("records no refile when no refile-decided denial matched", async () => {
    returned = [];
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toThrow();
    expect(stamped()).toBe(false);
  });

  it("surfaces a payer documentation gap (audit R19), then refiles with a reason", async () => {
    const gap = {
      payerName: "UHC",
      codes: ["99349"],
      missing: [{ element: "chief_complaint", label: "Chief complaint" }],
    };
    vi.mocked(markStatus).mockRejectedValueOnce(new DocumentationIncompleteError(gap));
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toBeInstanceOf(DocumentationIncompleteError);
    expect(stamped()).toBe(false);

    await markRefiled({
      orgId: ORG, id: DENIAL, actorUserId: USER,
      documentationOverride: { reason: "CC is documented in the addendum" },
    });
    expect(vi.mocked(markStatus).mock.calls.at(-1)![0].documentationOverride).toEqual({
      reason: "CC is documented in the addendum",
    });
    expect(stamped()).toBe(true);
  });

  it("stamps the refile when the queue had already sent the claim", async () => {
    vi.mocked(markStatus).mockRejectedValueOnce(
      new ValidationError("Illegal superbill transition submitted → submitted."),
    );
    await markRefiled({ orgId: ORG, id: DENIAL });
    expect(stamped()).toBe(true);
  });
});

describe("markRefiled — only the real race is tolerated", () => {
  const stamped = () => calls.some((s) => s.includes("UPDATE superbill_denial"));

  it("refuses a claim that is paid, and records no refile", async () => {
    resent = [];
    vi.mocked(markStatus).mockRejectedValueOnce(
      new ValidationError("Illegal superbill transition paid → submitted."),
    );
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toThrow(
      /This claim is paid, so it cannot be refiled/,
    );
    expect(stamped()).toBe(false);
  });

  it("refuses a voided claim the same way", async () => {
    resent = [];
    vi.mocked(markStatus).mockRejectedValueOnce(
      new ValidationError("Illegal superbill transition voided → submitted."),
    );
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).rejects.toThrow(/voided/);
    expect(stamped()).toBe(false);
  });

  it("tolerates it when the claim went back out after this denial, even if paid since", async () => {
    resent = [{ ok: 1 }];
    vi.mocked(markStatus).mockRejectedValueOnce(
      new ValidationError("Illegal superbill transition paid → submitted."),
    );
    await expect(markRefiled({ orgId: ORG, id: DENIAL })).resolves.toBeUndefined();
    expect(stamped()).toBe(true);
    expect(calls.find((s) => s.includes("a.kind = 'resubmitted'"))).toContain("a.at >= d.created_at");
  });
});
