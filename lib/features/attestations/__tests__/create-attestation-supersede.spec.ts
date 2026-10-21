/**
 * Re-verifying an attestation names one this org owns.
 *
 * POST /api/attestations takes supersedesId from the body, validated only as a
 * uuid. analyst_attestation.supersedes_id's foreign key is checked with row
 * security off, so another org's attestation id was stored as this one's
 * lineage even on the app role, and on a connection that bypasses RLS the
 * re-verify UPDATE, which matched on the id alone, retired the other org's
 * attestation as well.
 *
 * lib/db is mocked with a fake tx. The lookup and the re-verify UPDATE are run
 * by sql-fake over two orgs' attestations, the other org's first, with no RLS,
 * so their own predicates decide which row they reach. The INSERT is recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/rulebook/org-rule.repository", () => ({ upsertOrgRule: vi.fn().mockResolvedValue(undefined) }));

import { withOrgContext } from "@/lib/db";
import { run as runSql, type FakeDb } from "@/lib/features/team/__tests__/sql-fake";

import { createAttestation } from "../attestation.service";
import type { CreateAttestation } from "../attestation.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYER = "a0000000-0000-4000-8000-000000000303";
const OURS = "b0000000-0000-4000-8000-000000000001";
const OURS_EXPIRED = "b0000000-0000-4000-8000-000000000002";
const THEIRS = "b0000000-0000-4000-8000-000000000003";
const NEW_ID = "b0000000-0000-4000-8000-0000000000aa";

let db: FakeDb;
let inserted: unknown[][];

const att = (id: string, org_id: string, status: string) => ({
  id, org_id, payer_id: PAYER, state: "OH", cpt_code: "99350", attribute: "covered", status, updated_at: null,
});

function fakeTx() {
  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    if (sql.includes("INSERT INTO analyst_attestation")) {
      inserted.push(values);
      return Promise.resolve([{ id: NEW_ID }]);
    }
    if (sql.includes("analyst_attestation")) return Promise.resolve(runSql(db, strings, values));
    return Promise.resolve([]);
  };
  return { $queryRaw: exec, $executeRaw: exec };
}

beforeEach(() => {
  inserted = [];
  db = {
    analyst_attestation: {
      columns: ["id", "org_id", "payer_id", "state", "cpt_code", "attribute", "status", "updated_at"],
      rows: [att(THEIRS, OTHER_ORG, "active"), att(OURS, ORG, "active"), att(OURS_EXPIRED, ORG, "expired")],
    },
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const payload = (supersedesId: string): CreateAttestation => ({
  payerId: PAYER, state: "OH", cptCode: "99350", attribute: "covered", coverageStatus: "covered",
  payerRepName: "Pat at the payer", callDate: "2026-10-01", supersedesId,
});
const statusOf = (id: string) => db.analyst_attestation!.rows.find((r) => r.id === id)!.status;

describe("createAttestation — superseding", () => {
  it("refuses another org's attestation: not found, theirs untouched, nothing recorded", async () => {
    await expect(
      createAttestation({ orgId: ORG, attestedByUserId: USER, payload: payload(THEIRS) }),
    ).rejects.toMatchObject({ name: "NotFoundError", message: "The attestation this replaces was not found." });
    expect(statusOf(THEIRS)).toBe("active");
    expect(inserted).toEqual([]);
  });

  it("CONTROL: re-verifies this org's active attestation and records the new one against it", async () => {
    await expect(
      createAttestation({ orgId: ORG, attestedByUserId: USER, payload: payload(OURS) }),
    ).resolves.toEqual({ id: NEW_ID });
    expect(statusOf(OURS)).toBe("re_verified");
    expect(statusOf(THEIRS)).toBe("active");
    expect(inserted[0]).toContain(OURS);
  });

  it("re-verifies an expired one of this org's too: its lineage is kept, its status left alone", async () => {
    await expect(
      createAttestation({ orgId: ORG, attestedByUserId: USER, payload: payload(OURS_EXPIRED) }),
    ).resolves.toEqual({ id: NEW_ID });
    expect(statusOf(OURS_EXPIRED)).toBe("expired");
    expect(inserted[0]).toContain(OURS_EXPIRED);
  });
});
