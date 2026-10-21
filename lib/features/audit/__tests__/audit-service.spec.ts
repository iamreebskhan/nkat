/**
 * One visit's audit trail (audit R24).
 *
 * The buyer asked for "the note and the superbill for each visit". The log
 * recorded the pairing but could not be filtered by visit. The trail is the
 * visit's own rows, its claims' rows, their denials' rows, and rows whose
 * payload names the visit, including claims since deleted, which only the
 * payload still ties to it.
 *
 * lib/db is mocked with a fake tx that records SQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { listAuditLog } from "../audit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000a";

let calls: { sql: string; values: unknown[] }[] = [];
/** What the audit query answers. */
let rowsOut: unknown[] = [];

beforeEach(() => {
  calls = [];
  rowsOut = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join("¶"), values });
        return Promise.resolve(rowsOut);
      },
    }),
  );
});

describe("listAuditLog — one visit's trail", () => {
  it("matches the visit's rows, its claims', their denials', and rows naming it", async () => {
    await listAuditLog({ orgId: ORG, visitId: VISIT });
    const { sql, values } = calls[0]!;
    expect(sql).toContain("a.target_id = ");
    expect(sql).toContain("a.payload->>'visitId' = ");
    expect(sql).toContain("a.payload->>'fromVisitId' = ");
    expect(sql).toContain("SELECT s.id FROM superbill s WHERE s.visit_id = ");
    expect(sql).toContain("FROM superbill_denial d JOIN superbill s ON s.id = d.superbill_id");
    expect(values.filter((v) => v === VISIT)).toHaveLength(6);
  });

  it("binds null, so nothing is filtered, when no visit is asked for", async () => {
    await listAuditLog({ orgId: ORG });
    expect(calls[0]!.values).not.toContain(VISIT);
  });

  it("runs in the caller's org context", async () => {
    await listAuditLog({ orgId: ORG, visitId: VISIT });
    expect(vi.mocked(withOrgContext).mock.calls[0]![0]).toBe(ORG);
  });
});

describe("listAuditLog — canonical ids and free text (review fixes)", () => {
  it("compares payload ids in canonical form, so an uppercase id still finds them", async () => {
    await listAuditLog({ orgId: ORG, visitId: VISIT });
    expect(calls[0]!.sql).toContain("a.payload->>'visitId' = (¶::uuid)::text");
    expect(calls[0]!.sql).toContain("a.payload->>'fromVisitId' = (¶::uuid)::text");
  });

  it("strips free-text keys from payloads before they leave the server", async () => {
    rowsOut = [
      {
        id: "r1", user_email: null, action: "superbill_code_override", target_type: "superbill",
        target_id: "b2e303af-e2cb-4292-8d00-c35c07423a0d",
        payload: { code: "99350", reason: "Pt with metastatic NSCLC" },
        ip_address: null, user_agent: null, occurred_at: new Date("2026-09-14T00:00:00Z"),
      },
    ];
    const { rows } = await listAuditLog({ orgId: ORG, visitId: VISIT });
    expect(rows[0]!.payload).toEqual({ code: "99350" });
  });
});
