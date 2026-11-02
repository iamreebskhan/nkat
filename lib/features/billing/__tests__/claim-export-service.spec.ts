/**
 * Exporting claims for the billing software (0118; doc:72; Mark Q1 default):
 * reviewed claims only, hard stops refuse the whole export, and a batch, its
 * items, each claim's history line, one audit row and a PHI export record are
 * written. lib/db is mocked with a fake tx answering by statement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: vi.fn(),
}));
vi.mock("@/lib/hipaa/phi-access-log", () => ({ logPhiExport: vi.fn(async () => undefined) }));

import { createHash } from "node:crypto";

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import { exportClaims } from "../claim-export.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "5b000000-0000-4000-8000-00000000000a";
const B = "5b000000-0000-4000-8000-00000000000b";
const BATCH = "ba000000-0000-4000-8000-000000000001";

let calls: { sql: string; values: unknown[] }[];
let bills: Record<string, unknown>[];
let provider: Record<string, unknown> | null;

const bill = (id: string, over: Record<string, unknown> = {}) => ({
  id, visit_id: `v-${id.slice(-1)}`, patient_id: `p-${id.slice(-1)}`, status: "ready_to_submit", dos: "2026-10-27", pos: "12",
  cpt_codes: ["99349"], cpt_units: {}, modifiers: [], icd10_codes: ["C34.12"],
  pricing: { tier: "MD", lines: [{ code: "99349", rateCents: 7013, units: 1, chargeCents: 7013 }] },
  billed_amount_cents: 7013, expected_amount_cents: 7013, member_id_snapshot: "CS-1", provider_name: "Helen Okafor",
  provider_npi: "1234567893", rendering_taxonomy: null, payer_name: "CareSource Ohio", first_name: "Ruth", last_name: "Testcase",
  dob: "1941-05-12", sex: "F", address_line_1: "12 Elm St", address_line_2: null, city: "Columbus", state: "OH", zip: "43215",
  group_number: null, secondary_payer_name: null, secondary_member_id: null, ...over,
});

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FOR UPDATE OF s")) return Promise.resolve(bills);
    if (sql.includes("LEFT JOIN org_billing_provider")) return Promise.resolve(provider ? [provider] : [{}]);
    if (sql.includes("INSERT INTO claim_export_batch")) return Promise.resolve([{ id: BATCH, day: "2026-10-29" }]);
    if (sql.includes("FROM patient_prior_auth")) return Promise.resolve([]);
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  bills = [bill(A), bill(B, { cpt_codes: ["99350", "G0318"], cpt_units: { G0318: 2 } })];
  provider = {
    legal_name: "Demo Palliative (test)", npi: "1234567893", ein: "123456789", taxonomy_code: "193200000X",
    address_line_1: "1 Main St", address_line_2: null, city: "Columbus", state: "OH", zip: "43215",
    pay_to_address_line_1: null, pay_to_address_line_2: null, pay_to_city: null, pay_to_state: null, pay_to_zip: null, updated_at: new Date(),
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const run = (ids = [A, B]) => exportClaims({ orgId: ORG, userId: USER, superbillIds: ids });
const find = (s: string) => calls.filter((c) => c.sql.includes(s));

describe("exportClaims", () => {
  it("writes the file, the batch with its hash, each claim's item and history line, and one audit row", async () => {
    const r = await run();
    expect(r).toMatchObject({ batchId: BATCH, claims: 2, lines: 3, filename: "pallio-claims-2026-10-29-ba000000.csv", warnings: [] });
    expect(r.csv.split("\r\n")[1]!.startsWith(`${claimRefFor(A)},${A},`)).toBe(true);
    const batch = find("INSERT INTO claim_export_batch")[0]!;
    expect(batch.values).toEqual(expect.arrayContaining([2, 3, createHash("sha256").update(r.csv).digest("hex")]));
    expect(find("INSERT INTO claim_export_item")).toHaveLength(2);
    const trail = find("INSERT INTO superbill_activity");
    expect(trail).toHaveLength(2);
    expect(trail[0]!.sql).toContain("'exported'");
    expect(vi.mocked(writeAudit).mock.calls[0]![1]).toMatchObject({
      action: "claim_export", targetId: BATCH, payload: { batchId: BATCH, claims: 2, lines: 3, superbillIds: [A, B] },
    });
    expect(JSON.stringify(vi.mocked(writeAudit).mock.calls)).not.toContain("Testcase");
    expect(vi.mocked(logPhiExport)).toHaveBeenCalledWith(
      expect.objectContaining({ exportType: "claim_csv", patientIds: ["p-a", "p-b"], byteSize: Buffer.byteLength(r.csv) }),
    );
  });

  it("locks the claims it writes into the file", async () => {
    await run();
    expect(find("FOR UPDATE OF s")[0]!.values).toContainEqual([A, B]);
  });

  it("names the file by the practice's day, not UTC's", async () => {
    await run();
    const batch = find("INSERT INTO claim_export_batch")[0]!;
    expect(batch.sql).toMatch(/created_at AT TIME ZONE \(SELECT o\.timezone FROM org o WHERE o\.id = ¶::uuid\)/);
    expect(batch.values).toContain(ORG);
  });

  it("CONTROL: refuses an unreviewed claim, naming it, and writes nothing", async () => {
    bills = [bill(A), bill(B, { status: "draft" })];
    await expect(run()).rejects.toThrow(
      `Only reviewed claims are exported. ${claimRefFor(B)} is a draft: review it on its bill page first.`,
    );
    expect(find("INSERT INTO claim_export_batch")).toHaveLength(0);
    expect(logPhiExport).not.toHaveBeenCalled();
  });

  it("CONTROL: refuses the whole export over one claim's hard stop", async () => {
    bills = [bill(A), bill(B, { member_id_snapshot: "", icd10_codes: [] })];
    await expect(run()).rejects.toThrow(`Not exported: ${claimRefFor(B)} has no member ID, no diagnosis.`);
    expect(find("INSERT INTO claim_export_item")).toHaveLength(0);
  });

  it("CONTROL: a claim id the org does not have is not found", async () => {
    bills = [bill(A)];
    await expect(run()).rejects.toThrow(/not found/);
  });

  it("reports what the billing software will want, and still exports", async () => {
    provider = null;
    bills = [bill(A)];
    const r = await run([A]);
    expect(r.warnings).toEqual([
      { claimRef: claimRefFor(A), warnings: ["no billing NPI", "no EIN", "no billing address", "no billing taxonomy"] },
    ]);
    expect(find("INSERT INTO claim_export_batch")).toHaveLength(1);
  });
});
