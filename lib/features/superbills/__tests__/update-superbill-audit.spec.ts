/**
 * updateSuperbill and the audit log (review of audit R24).
 *
 * Two gaps the review found. Editing a reviewed bill sends it back to draft,
 * a status change that reached the claim history but not the audit trail.
 * And the code-override row stored the biller's typed reason in audit_log,
 * which holds no free text; the reason belongs on the claim history.
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { updateSuperbill } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const SB = "b2e303af-e2cb-4292-8d00-c35c07423a0d";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let status: string;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id, status FROM superbill")) return Promise.resolve([{ id: SB, status }]);
    if (sql.includes("SET status = 'draft'")) return Promise.resolve([{ visit_id: VISIT }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  status = "ready_to_submit";
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const auditRows = () => calls.filter((c) => c.sql.includes("INSERT INTO audit_log"));
const payloadOf = (c: { values: unknown[] }) =>
  JSON.parse(String(c.values.find((v) => typeof v === "string" && v.startsWith("{"))));

describe("updateSuperbill — audit rows", () => {
  it("records a reviewed bill going back to draft as a status change, with its visit", async () => {
    await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { icd10Codes: ["C34.90"] } });
    const change = auditRows().find((c) => c.values.includes("superbill_status_change"))!;
    expect(change).toBeDefined();
    expect(change.values).toContain(USER);
    expect(change.values).toContain(SB);
    expect(payloadOf(change)).toEqual({ from: "ready_to_submit", to: "draft", visitId: VISIT });
  });

  it("writes no status change for an edit that does not send the bill back", async () => {
    status = "draft";
    await updateSuperbill({ orgId: ORG, id: SB, userId: USER, patch: { icd10Codes: ["C34.90"] } });
    expect(auditRows().some((c) => c.values.includes("superbill_status_change"))).toBe(false);
  });

  it("keeps the override reason out of the audit log — code and length only", async () => {
    status = "draft";
    const reason = "Pt with metastatic NSCLC, prolonged service documented";
    await updateSuperbill({
      orgId: ORG, id: SB, userId: USER,
      patch: { icd10Codes: ["C34.90"] },
      overrides: [{ code: "99350", reason }],
    });
    const override = auditRows().find((c) => c.sql.includes("'superbill_code_override'"))!;
    expect(payloadOf(override)).toEqual({ code: "99350", reasonLength: reason.length });
    expect(JSON.stringify(override.values)).not.toContain("NSCLC");
    // The reason is still on the claim history, behind billing permissions.
    const activity = calls.find((c) => c.sql.includes("INSERT INTO superbill_activity"))!;
    expect(JSON.stringify(activity.values)).toContain("NSCLC");
  });
});
