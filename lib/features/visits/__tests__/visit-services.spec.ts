/**
 * Visit services catalog + what was provided on a visit.
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  withOrgContext: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import {
  createService,
  setVisitServices,
  updateService,
} from "../visit-services.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "22222222-2222-4222-8222-222222222222";
const SVC_A = "33333333-3333-4333-8333-333333333333";
const SVC_B = "44444444-4444-4444-8444-444444444444";

let calls: { sql: string; values: unknown[] }[] = [];
/** Names already in the catalog — drives the duplicate check. */
let existingNames: string[] = [];
/** Catalog ids that exist AND are active. */
let activeIds: string[] = [];
let visitExists = true;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });

    if (sql.includes("SELECT id FROM visit_service WHERE lower(name)") ||
        sql.includes("SELECT id FROM visit_service\n         WHERE lower(name)")) {
      const wanted = String(values[0] ?? "").toLowerCase();
      return Promise.resolve(
        existingNames.some((n) => n.toLowerCase() === wanted) ? [{ id: SVC_A }] : [],
      );
    }
    if (sql.includes("SELECT id FROM visit WHERE id")) {
      return Promise.resolve(visitExists ? [{ id: VISIT }] : []);
    }
    if (sql.includes("AND active")) {
      const asked = (values[0] as string[]) ?? [];
      return Promise.resolve(asked.filter((i) => activeIds.includes(i)).map((id) => ({ id })));
    }
    if (sql.includes("INSERT INTO visit_service (")) {
      return Promise.resolve([{ id: SVC_B }]);
    }
    // $executeRaw returns a row count; UPDATE paths check it for 0.
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  calls = [];
  existingNames = [];
  activeIds = [SVC_A, SVC_B];
  visitExists = true;
  vi.mocked(withOrgContext).mockImplementation(async (_orgId, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("createService", () => {
  it("inserts and returns the new id", async () => {
    const r = await createService({
      orgId: ORG,
      payload: { name: "Bereavement support", category: "psychosocial" },
    });
    expect(r).toEqual({ id: SVC_B });
    expect(calls.some((c) => c.sql.includes("INSERT INTO visit_service ("))).toBe(true);
  });

  it("rejects a duplicate name regardless of case", async () => {
    existingNames = ["Wound care"];
    await expect(
      createService({ orgId: ORG, payload: { name: "wound CARE", category: "clinical" } }),
    ).rejects.toThrow(/already in the catalog/);
    // Nothing should have been written.
    expect(calls.some((c) => c.sql.includes("INSERT INTO visit_service ("))).toBe(false);
  });
});

describe("updateService", () => {
  it("deactivates without deleting — history has to survive", async () => {
    await updateService({ orgId: ORG, id: SVC_A, payload: { active: false } });
    const upd = calls.find((c) => c.sql.includes("UPDATE visit_service SET"));
    expect(upd).toBeDefined();
    expect(upd!.values).toContain(false);
    expect(calls.some((c) => c.sql.includes("DELETE FROM visit_service"))).toBe(false);
  });

  it("rejects renaming onto another service's name", async () => {
    existingNames = ["Wound care"];
    await expect(
      updateService({ orgId: ORG, id: SVC_A, payload: { name: "Wound care" } }),
    ).rejects.toThrow(/already in the catalog/);
  });
});

describe("setVisitServices", () => {
  it("replaces the whole set so unticking actually removes", async () => {
    const r = await setVisitServices({
      orgId: ORG,
      visitId: VISIT,
      payload: { services: [{ serviceId: SVC_A, minutes: 15 }] },
    });
    expect(r).toEqual({ count: 1 });
    const deleteIdx = calls.findIndex((c) => c.sql.includes("DELETE FROM visit_service_provided"));
    const insertIdx = calls.findIndex((c) => c.sql.includes("INSERT INTO visit_service_provided"));
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    // The delete must come first, or the insert gets wiped.
    expect(deleteIdx).toBeLessThan(insertIdx);
  });

  it("clears everything when an empty set is sent", async () => {
    const r = await setVisitServices({ orgId: ORG, visitId: VISIT, payload: { services: [] } });
    expect(r).toEqual({ count: 0 });
    expect(calls.some((c) => c.sql.includes("DELETE FROM visit_service_provided"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO visit_service_provided"))).toBe(false);
  });

  it("refuses ids outside the org's active catalog, and writes nothing", async () => {
    activeIds = [SVC_A];
    await expect(
      setVisitServices({
        orgId: ORG,
        visitId: VISIT,
        payload: { services: [{ serviceId: SVC_A }, { serviceId: SVC_B }] },
      }),
    ).rejects.toThrow(/not in your catalog/);
    expect(calls.some((c) => c.sql.includes("DELETE FROM visit_service_provided"))).toBe(false);
  });

  it("404s on an unknown visit", async () => {
    visitExists = false;
    await expect(
      setVisitServices({ orgId: ORG, visitId: VISIT, payload: { services: [] } }),
    ).rejects.toThrow(/Visit not found/);
  });
});
