/**
 * A reviewed bill that changes goes back to draft (audit R26).
 *
 * "Ready to submit" means someone reviewed THIS bill. An edit after that used
 * to keep the status, so the claim that went out was not the one reviewed.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/billing/predict-superbill.service", () => ({
  predictSuperbill: vi.fn().mockResolvedValue(null),
}));

import { withOrgContext } from "@/lib/db";

import { updateSuperbill } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

let currentStatus: string;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id, status FROM superbill")) {
      return Promise.resolve([{ id: SB, status: currentStatus }]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

const statusWrite = () => calls.find((c) => c.sql.includes("SET status = 'draft'"));
const activity = () => calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;

beforeEach(() => {
  calls = [];
  currentStatus = "draft";
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("updateSuperbill — edits after review (audit R26)", () => {
  it("sends a ready-to-submit bill back to draft, and says why", async () => {
    currentStatus = "ready_to_submit";
    const r = await updateSuperbill({
      orgId: ORG, id: SB, userId: USER, patch: { icd10Codes: ["C34.10"] },
    });
    expect(statusWrite()).toBeDefined();
    expect(r.status).toBe("draft");
    // from ready_to_submit, to draft.
    expect(activity().values).toContain("ready_to_submit");
    expect(activity().values).toContain("draft");
    expect(activity().values).toContain(
      "Edited after review — updated ICD-10 codes — back to draft for re-review",
    );
  });

  it("never writes a status when editing a draft", async () => {
    currentStatus = "draft";
    const r = await updateSuperbill({
      orgId: ORG, id: SB, userId: USER, patch: { icd10Codes: ["C34.10"] },
    });
    expect(statusWrite()).toBeUndefined();
    expect(r.status).toBeUndefined();
    expect(activity().values).toContain("Edited ICD-10 codes");
  });

  it("keeps a denied bill denied while it is corrected for refiling", async () => {
    currentStatus = "denied";
    await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { icd10Codes: ["C34.10"] } });
    expect(statusWrite()).toBeUndefined();
    expect(activity().values).toContain("Corrected after denial — updated ICD-10 codes");
  });

  it("still refuses to edit a claim that is with the payer", async () => {
    currentStatus = "submitted";
    await expect(
      updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { icd10Codes: ["C34.10"] } }),
    ).rejects.toThrow(/only draft, ready-to-submit or denied/);
  });

  it("does not send a reviewed bill back when nothing changed", async () => {
    currentStatus = "ready_to_submit";
    const r = await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: {} });
    expect(r.updated).toBe(false);
    expect(statusWrite()).toBeUndefined();
  });
});
