/**
 * Addenda to a signed note (audit R15).
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { addVisitAddendum, listVisitAddenda } from "../addendum.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BODY = "Late entry: daughter present and agreed with plan.";

let status: string | null;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT status FROM visit")) return Promise.resolve(status ? [{ status }] : []);
    if (sql.includes("INSERT INTO visit_addendum")) {
      return Promise.resolve([{
        id: "ad-1", body: values[2], author_user_id: USER, author_credential: "NP",
        signed_at: new Date("2026-09-14T10:00:00Z"), author_name: "Test Admin",
      }]);
    }
    if (sql.includes("FROM visit_addendum a")) {
      return Promise.resolve([{
        id: "ad-1", body: BODY, author_user_id: USER, author_credential: "NP",
        signed_at: new Date("2026-09-14T10:00:00Z"), author_name: "Test Admin",
      }]);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const inserted = () => calls.some((c) => c.sql.includes("INSERT INTO visit_addendum"));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  status = "billed";
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("addVisitAddendum", () => {
  for (const s of ["documented", "pending_billing", "billed"]) {
    it(`records an addendum on a ${s} visit, with the author's credential`, async () => {
      status = s;
      const r = await addVisitAddendum({ orgId: ORG, visitId: VISIT, userId: USER, body: `  ${BODY}  ` });
      expect(r).toMatchObject({ id: "ad-1", body: BODY, authorName: "Test Admin", authorCredential: "NP" });
      expect(calls.find((c) => c.sql.includes("INSERT INTO visit_addendum"))!.sql).toContain(
        "FROM clinician_profile",
      );
    });
  }

  for (const s of ["scheduled", "in_progress"]) {
    it(`refuses a ${s} visit — edit the note itself — and writes nothing`, async () => {
      status = s;
      await expect(
        addVisitAddendum({ orgId: ORG, visitId: VISIT, userId: USER, body: BODY }),
      ).rejects.toThrow(/has not been signed/);
      expect(inserted()).toBe(false);
    });
  }

  it("refuses an empty or oversized addendum before opening a transaction", async () => {
    await expect(addVisitAddendum({ orgId: ORG, visitId: VISIT, userId: USER, body: "   " })).rejects.toThrow(
      /needs some text/,
    );
    await expect(
      addVisitAddendum({ orgId: ORG, visitId: VISIT, userId: USER, body: "x".repeat(20_001) }),
    ).rejects.toThrow(/at most 20,000/);
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("404s a missing visit", async () => {
    status = null;
    await expect(
      addVisitAddendum({ orgId: ORG, visitId: VISIT, userId: USER, body: BODY }),
    ).rejects.toThrow(/not found/i);
  });

  it("audits the addendum by id and length, never its text", async () => {
    await addVisitAddendum({ orgId: ORG, visitId: VISIT, userId: USER, body: BODY });
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.action).toBe("visit_addendum");
    expect(entry.targetId).toBe(VISIT);
    expect(entry.payload).toEqual({ addendumId: "ad-1", length: BODY.length });
    expect(JSON.stringify(entry.payload)).not.toContain("daughter");
  });

  it("never updates or deletes an addendum or the note", async () => {
    await addVisitAddendum({ orgId: ORG, visitId: VISIT, userId: USER, body: BODY });
    for (const c of calls) {
      expect(c.sql).not.toMatch(/UPDATE visit_addendum|DELETE FROM visit_addendum|visit_note_section/);
    }
  });
});

describe("listVisitAddenda", () => {
  it("lists a visit's addenda in the order they were signed", async () => {
    const rows = await listVisitAddenda({ orgId: ORG, visitId: VISIT });
    expect(rows).toEqual([
      expect.objectContaining({ body: BODY, authorName: "Test Admin", signedAt: "2026-09-14T10:00:00.000Z" }),
    ]);
    expect(calls[0]!.sql).toContain("ORDER BY a.signed_at, a.id");
  });
});
