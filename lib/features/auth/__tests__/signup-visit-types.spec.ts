/**
 * Signup seeds the new org's visit types from DEFAULT_VISIT_TYPES.
 *
 * Audit R22 took 'telehealth' out of the coding bands — 0099 rewrites the
 * org_visit_type CHECK without it — while the seeded 'telehealth' TYPE stays.
 * Signup used to insert every slug as its own coding_basis, so after 0099 the
 * telehealth row would violate the CHECK and roll back every signup. This pins
 * that the band written is the declared one, never the slug.
 *
 * prisma is mocked; the transaction runs against a fake tx that records SQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), transaction: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: h.queryRaw, $transaction: h.transaction },
  withOrgContext: vi.fn(),
  withBreakglass: vi.fn(),
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed"), compare: vi.fn() },
}));
vi.mock("@/lib/features/auth/password-policy", () => ({
  checkPassword: () => ({ ok: true }),
}));

import { signup } from "../auth.service";
import { VISIT_TYPES } from "@/lib/features/visits/visit.types";
import { DEFAULT_VISIT_TYPES } from "@/lib/features/visits/visit-types.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let txCalls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    txCalls.push({ sql, values });
    if (sql.includes("INSERT INTO app_user")) return Promise.resolve([{ id: USER }]);
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run, $executeRawUnsafe: () => Promise.resolve() };
}

beforeEach(() => {
  txCalls = [];
  // No existing email or org slug; the pre-generated org id.
  h.queryRaw.mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve(strings.join("¶").includes("gen_random_uuid") ? [{ id: ORG }] : []),
  );
  h.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx()));
});

describe("signup — seeded visit types (audit R22)", () => {
  const signUp = () =>
    signup({
      email: "owner@example.test",
      password: "not-checked-here",
      fullName: "Practice Owner",
      orgName: "Riverside Palliative",
      baaAccepted: true,
    });
  const typeInserts = () => txCalls.filter((c) => c.sql.includes("INSERT INTO org_visit_type"));

  it("succeeds and seeds every default type", async () => {
    const r = await signUp();
    expect("session" in r).toBe(true);
    expect(typeInserts()).toHaveLength(DEFAULT_VISIT_TYPES.length);
  });

  it("writes each type's declared band, which is always one the CHECK accepts", async () => {
    await signUp();
    // values: org, slug, label, coding_basis, is_telehealth, sort_order
    for (const c of typeInserts()) {
      expect(VISIT_TYPES as readonly string[]).toContain(c.values[3]);
    }
  });

  it("seeds the telehealth type as established with the modality forced on", async () => {
    await signUp();
    const tele = typeInserts().find((c) => c.values[1] === "telehealth")!;
    expect(tele.sql).toContain("is_telehealth");
    expect(tele.values[3]).toBe("established_patient_home");
    expect(tele.values[4]).toBe(true);
  });

  it("CONTROL — an in-person type keeps its own band and no flag", async () => {
    await signUp();
    const np = typeInserts().find((c) => c.values[1] === "new_patient_home")!;
    expect(np.values[3]).toBe("new_patient_home");
    expect(np.values[4]).toBe(false);
  });
});
