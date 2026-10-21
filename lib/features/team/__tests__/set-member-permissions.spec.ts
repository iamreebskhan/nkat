/**
 * A change to what a member may do is audited (audit R38).
 *
 * lib/db is mocked with ./sql-fake, which runs the service's statements
 * against in-memory tables holding two orgs and applies no RLS. So the grants
 * a save reads, deletes and writes are the ones its SQL actually selects, not
 * a canned answer keyed on the statement's wording.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { ALL_PERMISSIONS, unknownPermissionMessage } from "../team.types";
import { setMemberPermissions } from "../team.service";
import { fakeTx, type FakeDb, type SqlRow } from "./sql-fake";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const grant = (org_id: string, permission: string) => ({
  org_id,
  user_id: USER,
  pending_invite_id: null,
  permission,
  granted_by_user_id: ADMIN,
});

let db: FakeDb;
/** Every statement the service issued, so a test can prove one did NOT run. */
let executed: string[];

/** The permissions USER holds in `org`, sorted. */
function held(org: string): string[] {
  return db
    .user_permission!.rows.filter((r: SqlRow) => r.org_id === org && r.user_id === USER)
    .map((r) => String(r.permission))
    .sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  executed = [];
  db = {
    org_member: {
      columns: ["org_id", "user_id", "status"],
      rows: [
        { org_id: ORG, user_id: USER, status: "active" },
        { org_id: OTHER_ORG, user_id: USER, status: "active" },
      ],
    },
    user_permission: {
      columns: ["org_id", "user_id", "pending_invite_id", "permission", "granted_by_user_id"],
      unique: ["user_id", "org_id", "permission"],
      rows: [
        grant(ORG, "audit.view"),
        grant(ORG, "patients.list"),
        // The same person's grant in another org: nothing a save here may touch.
        grant(OTHER_ORG, "billing.lookup.view"),
      ],
    },
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx(db, executed)),
  );
});

describe("setMemberPermissions — audited (audit R38)", () => {
  it("records what was added and what was removed, by permission name", async () => {
    await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN,
      permissions: ["patients.list", "knowledge.attest"],
    });
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.action).toBe("team_permissions_update");
    expect(entry.userId).toBe(ADMIN);
    expect(entry.targetId).toBe(USER);
    expect(entry.payload).toEqual({ added: ["knowledge.attest"], removed: ["audit.view"] });
  });

  it("reports the counts before and after", async () => {
    const r = await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: ["patients.list"],
    });
    expect(r).toEqual({ before: 2, after: 1 });
  });

  it("writes no audit entry when nothing changed", async () => {
    await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: ["patients.list", "audit.view"],
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("404s someone who is not an active member, and says which condition failed", async () => {
    db.org_member!.rows[0]!.status = "suspended";
    await expect(
      setMemberPermissions({ orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: [] }),
    ).rejects.toThrow("Member not found among this org's active members.");
    expect(held(ORG)).toEqual(["audit.view", "patients.list"]);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

/**
 * One person, two orgs. A save in one org used to read and delete by user
 * alone, so on a connection without RLS it removed the member's grants in the
 * other org too, and the audit entry listed them as removed here.
 */
describe("setMemberPermissions — a save stays inside its org", () => {
  it("replaces this org's set and leaves the member's grants elsewhere alone", async () => {
    await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: ["patients.list", "knowledge.attest"],
    });
    expect(held(ORG)).toEqual(["knowledge.attest", "patients.list"]);
    expect(held(OTHER_ORG)).toEqual(["billing.lookup.view"]);
  });
});

/**
 * Unticking every box and saving used to DELETE every row and INSERT none, so
 * the member kept their sign-in and could open nothing. The invite path has
 * always refused the same input (InviteSchema); this is the authoritative
 * layer, so it refuses it too — the route's own schema is not the only guard.
 */
describe("setMemberPermissions — an empty set is refused", () => {
  it("rejects it as caller error, with a message that says what to do instead", async () => {
    const call = setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: [],
    });
    await expect(call).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setMemberPermissions({ orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: [] }),
    ).rejects.toThrow(/at least one permission/i);
  });

  it("leaves the grants the member already has exactly where they were", async () => {
    await expect(
      setMemberPermissions({ orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: [] }),
    ).rejects.toThrow();
    expect(executed.some((sql) => /DELETE FROM user_permission/.test(sql))).toBe(false);
    expect(held(ORG)).toEqual(["audit.view", "patients.list"]);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("still accepts a set with one permission left in it", async () => {
    const r = await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: ["patients.list"],
    });
    expect(r).toEqual({ before: 2, after: 1 });
    expect(executed.some((sql) => /DELETE FROM user_permission/.test(sql))).toBe(true);
    expect(held(ORG)).toEqual(["patients.list"]);
  });
});

/**
 * A name outside the catalogue is refused HERE, not only in the route's body
 * schema — the same depth the empty-set rule already sat at.
 *
 * The rows below are written from args.permissions verbatim, so a caller that
 * reached this function past the route would INSERT the typo into
 * user_permission; listMembers reads that column back and /team draws it as a
 * grant, while no requireAuth list will ever match it. The member is shown
 * access they do not have.
 *
 * "patients.vieww" is a typo for a real permission on purpose: it is the shape
 * an admin actually produces, and it is one character from a name the very
 * same save also carries, so a guard that refused the whole set on sight would
 * be caught by the control below.
 */
const MISSPELT = "patients.vieww";

describe("setMemberPermissions — a name outside the catalogue is refused", () => {
  it("is not a permission this product defines", () => {
    // The premise, against the shipped catalogue rather than a list typed here.
    // If "patients.vieww" were ever added to a template, every assertion below
    // would be testing nothing, and this line says so first.
    expect(ALL_PERMISSIONS).not.toContain(MISSPELT);
    expect(ALL_PERMISSIONS).toContain("patients.view");
  });

  it("throws ValidationError naming the misspelt name and not the valid ones", async () => {
    const err = await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN,
      permissions: ["patients.view", MISSPELT],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(unknownPermissionMessage([MISSPELT]));
    expect((err as Error).message).not.toContain('"patients.view"');
  });

  it("leaves the member's stored grants exactly where they were", async () => {
    await expect(
      setMemberPermissions({
        orgId: ORG, userId: USER, grantedByUserId: ADMIN,
        permissions: ["patients.view", MISSPELT],
      }),
    ).rejects.toThrow();
    // The refusal is a fact about the table: the DELETE that replaces the set
    // never ran, so the two grants the member had are still the two they have.
    expect(executed.some((sql) => /DELETE FROM user_permission/.test(sql))).toBe(false);
    expect(held(ORG)).toEqual(["audit.view", "patients.list"]);
    // Nothing was inserted either — in particular not the typo.
    expect(held(ORG)).not.toContain(MISSPELT);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("the sentence the admin reads is true about this save", async () => {
    // House rule: copy a user reads must be true. The message used to say a
    // name spelled any other way "is saved as a grant that nothing ever
    // checks" — present tense, describing the behaviour this refusal replaced.
    // Nothing is saved now, and the test above is what proves it: no DELETE,
    // the same two grants, no audit entry.
    const err = await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN, permissions: [MISSPELT],
    }).catch((e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toContain("Nothing was saved");
    expect(message).not.toMatch(/\bis (saved|stored)\b/);
    expect(held(ORG)).toEqual(["audit.view", "patients.list"]);
  });

  it("CONTROL: the same save with the name spelled right goes through", async () => {
    // Without this, a check that refused every set would pass everything above
    // and make the member editor unusable.
    const r = await setMemberPermissions({
      orgId: ORG, userId: USER, grantedByUserId: ADMIN,
      permissions: ["patients.view", "patients.list"],
    });
    expect(r).toEqual({ before: 2, after: 2 });
    expect(held(ORG)).toEqual(["patients.list", "patients.view"]);
    expect(held(OTHER_ORG)).toEqual(["billing.lookup.view"]);
  });
});
