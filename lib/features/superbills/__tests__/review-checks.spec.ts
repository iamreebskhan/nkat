/**
 * The review checkpoint's checks (0118; doc:71; Mark Q5 default): hard stops
 * refuse marking a claim ready and submitting it; any other finding asks for a
 * reason, which the claim history keeps and the audit row names by kind only.
 * lib/db is mocked with a fake tx answering by statement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: vi.fn(),
}));
vi.mock("@/lib/features/visits/documentation-check.service", () => ({
  loadDocumentationGaps: vi.fn(async () => ({ results: [], payerName: null })),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { ReviewWarningsError } from "@/lib/features/billing/claim-checks.service";

import { markStatus } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const BILL = "5b000000-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let calls: { sql: string; values: unknown[] }[];
let status: string;
let bill: Record<string, unknown>;
let edits: { column1_code: string; column2_code: string; modifier_indicator: number }[];
let notCovered: { code: string }[];
let authRequired: { code: string }[];
let auths: Record<string, unknown>[];
let billsOnAuth: number;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT status, provider_npi, visit_id FROM superbill")) {
      return Promise.resolve([{ status, provider_npi: "1234567893", visit_id: "v" }]);
    }
    if (sql.includes("SELECT s.cpt_codes, s.cpt_units, s.modifiers")) return Promise.resolve([bill]);
    // The practice's own loaded edits (0122).
    if (sql.includes("FROM org_ncci_ptp")) return Promise.resolve(edits);
    if (sql.includes("FROM org_ncci_mue")) return Promise.resolve([]);
    if (sql.includes("'prior_auth_required'")) return Promise.resolve(authRequired);
    if (sql.includes("FROM payer_rule pr")) return Promise.resolve(notCovered);
    if (sql.includes("FROM patient_prior_auth")) return Promise.resolve(auths);
    if (sql.includes("count(*) AS n FROM superbill s")) return Promise.resolve([{ n: billsOnAuth }]);
    return Promise.resolve(sql.trimStart().startsWith("UPDATE") || sql.trimStart().startsWith("INSERT") ? 1 : []);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  status = "draft";
  bill = {
    cpt_codes: ["99349", "99497"], cpt_units: {}, modifiers: [], icd10_codes: ["C34.12"], member_id_snapshot: "M1",
    pricing: { tier: "MD", lines: [{ code: "99349", rateCents: 7013, units: 1, chargeCents: 7013 }, { code: "99497", rateCents: 7660, units: 1, chargeCents: 7660 }] },
    payer_id: "pay", dos: "2026-10-27", state: "OH", payer_name: "CareSource Ohio", payer_type: "medicaid_mco",
  };
  edits = [];
  notCovered = [];
  authRequired = [];
  auths = [];
  billsOnAuth = 0;
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const ready = (extra: Partial<Parameters<typeof markStatus>[0]> = {}) =>
  markStatus({ orgId: ORG, id: BILL, to: "ready_to_submit", actorUserId: USER, ...extra });
const moved = () => calls.filter((c) => c.sql.includes("UPDATE superbill SET status"));

describe("marking a claim ready", () => {
  it("CONTROL: a clean claim is marked ready with nothing asked", async () => {
    await expect(ready()).resolves.toEqual({ from: "draft", to: "ready_to_submit" });
    expect(moved()).toHaveLength(1);
  });

  it("refuses a claim with no member ID, diagnosis or CPT code, override or not, and moves nothing", async () => {
    bill = { ...bill, member_id_snapshot: "", icd10_codes: [] };
    await expect(ready({ reviewOverride: { reason: "Billing will add it" } })).rejects.toThrow(
      /This claim has no member ID, no diagnosis\. A payer rejects a claim without them/,
    );
    expect(moved()).toHaveLength(0);
  });

  it("asks for a reason over an NCCI pair, a $0 line and a code the payer does not cover", async () => {
    edits = [{ column1_code: "99349", column2_code: "99497", modifier_indicator: 1 }];
    notCovered = [{ code: "99497" }];
    bill = { ...bill, pricing: { tier: "MD", lines: [{ code: "99349", rateCents: 7013, units: 1, chargeCents: 7013 }, { code: "99497", rateCents: 0, units: 1, chargeCents: 0 }] } };
    const err = await ready().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewWarningsError);
    expect((err as ReviewWarningsError).warnings.map((w) => `${w.kind}:${w.code}`)).toEqual([
      "ncci_ptp:99497", "zero_charge:99497", "not_covered:99497",
    ]);
    expect(moved()).toHaveLength(0);
  });

  it("goes ahead with the reason, kept on the claim history; the audit row names the warnings, not the reason", async () => {
    edits = [{ column1_code: "99349", column2_code: "99497", modifier_indicator: 1 }];
    await ready({ reviewOverride: { reason: "ACP was a separate conversation; modifier 25 added on the E/M line" } });
    expect(moved()).toHaveLength(1);
    const trail = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(trail.values.find((v) => typeof v === "string" && v.includes("over 1 review warning"))).toBeDefined();
    const detail = JSON.parse(trail.values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(detail.reviewOverride).toEqual({ warnings: ["ncci_ptp:99497"], reason: "ACP was a separate conversation; modifier 25 added on the E/M line" });
    const audit = vi.mocked(writeAudit).mock.calls.at(-1)![1];
    expect(audit.payload).toMatchObject({ to: "ready_to_submit", reviewOverride: ["ncci_ptp:99497"] });
    expect(JSON.stringify(audit.payload)).not.toContain("separate conversation");
  });

  it("CONTROL: a bypass modifier on the bill still asks, saying which modifier may separate the pair", async () => {
    edits = [{ column1_code: "99349", column2_code: "99497", modifier_indicator: 1 }];
    bill = { ...bill, modifiers: ["25"] };
    const err = (await ready().catch((e: unknown) => e)) as ReviewWarningsError;
    expect(err.warnings[0]!.detail).toMatch(/modifier 25 may separate/);
  });
});

describe("prior authorization (0124)", () => {
  const auth = (extra: Record<string, unknown> = {}) => ({
    id: "a", patient_id: "pt", payer_id: "pay", auth_number: "AUTH-1", codes: [], valid_from: "2026-10-01", valid_to: "2026-12-31",
    visits_authorized: null, status: "active", ...extra,
  });
  beforeEach(() => {
    bill = { ...bill, patient_id: "pt" };
  });
  const warned = async () => ((await ready().catch((e: unknown) => e)) as ReviewWarningsError).warnings ?? [];

  it("asks when the payer's firm rule requires one and none is on the chart", async () => {
    authRequired = [{ code: "99349" }];
    const [w] = await warned();
    expect(w).toMatchObject({ kind: "prior_auth", code: "99349" });
    expect(w!.detail).toBe("CareSource Ohio requires prior authorization for 99349, and none on the chart covers 2026-10-27.");
  });

  it("CONTROL: an authorization covering the date and code answers it", async () => {
    authRequired = [{ code: "99349" }];
    auths = [auth({ codes: ["99349"] })];
    await expect(ready()).resolves.toEqual({ from: "draft", to: "ready_to_submit" });
  });

  it("one that has ended, is for another plan, or names other codes does not", async () => {
    authRequired = [{ code: "99349" }];
    for (const a of [auth({ valid_to: "2026-10-26" }), auth({ payer_id: "other" }), auth({ codes: ["99350"] })]) {
      auths = [a];
      expect((await warned()).map((w) => w.kind)).toEqual(["prior_auth"]);
    }
  });

  it("says nothing with no firm rule, whatever the chart holds", async () => {
    await expect(ready()).resolves.toEqual({ from: "draft", to: "ready_to_submit" });
  });

  it("asks when a capped authorization's visits have run out, and not before", async () => {
    auths = [auth({ visits_authorized: 3 })];
    billsOnAuth = 2;
    await expect(ready()).resolves.toEqual({ from: "draft", to: "ready_to_submit" });
    billsOnAuth = 3;
    const [w] = await warned();
    expect(w!.detail).toBe("Authorization AUTH-1 allows 3 visits, and this claim goes past that.");
  });
});

describe("submitting", () => {
  it("refuses a hard stop on a refile too, and never holds a payer's 835", async () => {
    status = "denied";
    bill = { ...bill, member_id_snapshot: "" };
    await expect(markStatus({ orgId: ORG, id: BILL, to: "submitted", actorUserId: USER })).rejects.toThrow(/no member ID/);
    // CONTROL: the payer's own remittance is the payer's word, not a review.
    calls = [];
    await expect(
      markStatus({ orgId: ORG, id: BILL, to: "submitted", source: { kind: "remittance", remittanceFileId: "f", traceNumber: null } }),
    ).resolves.toEqual({ from: "denied", to: "submitted" });
    expect(calls.some((c) => c.sql.includes("FROM org_ncci_ptp"))).toBe(false);
  });
});
