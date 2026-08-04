/**
 * A signed note is an attestation. documentVisit must refuse edits once the
 * visit is signed, or a claim ends up supported by documentation nobody
 * attested to — the editor's autosave-on-blur used to keep rewriting it.
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { documentVisit } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "22222222-2222-4222-8222-222222222222";

let currentStatus: string;
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id, status FROM visit")) {
      return Promise.resolve(currentStatus ? [{ id: VISIT, status: currentStatus }] : []);
    }
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  currentStatus = "in_progress";
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("documentVisit", () => {
  it("saves while the visit is still in progress", async () => {
    const r = await documentVisit({
      orgId: ORG,
      id: VISIT,
      payload: { documentText: "SUBJECTIVE: comfortable." },
    });
    expect(r).toEqual({ updated: true });
    expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(true);
  });

  it("saves a scheduled visit and bumps it to in_progress", async () => {
    currentStatus = "scheduled";
    await documentVisit({ orgId: ORG, id: VISIT, payload: { acpMinutes: 20 } });
    const upd = calls.find((c) => c.sql.includes("UPDATE visit SET"));
    expect(upd!.sql).toContain("'in_progress'");
  });

  for (const status of ["documented", "pending_billing", "billed"]) {
    it(`refuses to rewrite a ${status} visit, and writes nothing`, async () => {
      currentStatus = status;
      await expect(
        documentVisit({ orgId: ORG, id: VISIT, payload: { documentText: "tampered" } }),
      ).rejects.toThrow(/signed and submitted/i);
      expect(calls.some((c) => c.sql.includes("UPDATE visit SET"))).toBe(false);
    });
  }

  it("404s a missing visit rather than silently no-oping", async () => {
    currentStatus = "";
    await expect(
      documentVisit({ orgId: ORG, id: VISIT, payload: { acpMinutes: 5 } }),
    ).rejects.toThrow(/not found/i);
  });
});
