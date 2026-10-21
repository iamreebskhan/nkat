/**
 * /team's Invites tab, and the "N pending invites" count in its header, list
 * this org's outstanding invites and nobody else's.
 *
 * listInvites used to filter on redeemed_at alone and leave the org to RLS.
 * On a connection that bypasses RLS (.env.local notes that the preview
 * deployment runs as a superuser) that showed every org's invitees. ./sql-fake
 * runs the service's SQL over two orgs' rows with no RLS, so the query has to
 * bound itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { listInvites } from "../team.service";
import { fakeTx, type FakeDb } from "./sql-fake";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLDER = "10000000-0000-4000-8000-000000000001";
const NEWER = "10000000-0000-4000-8000-000000000002";
const REDEEMED = "10000000-0000-4000-8000-000000000003";
const ELSEWHERE = "20000000-0000-4000-8000-000000000001";

const invite = (id: string, org_id: string, email: string, created: string, redeemed: string | null) => ({
  id,
  org_id,
  email,
  role_template: "clinician",
  invited_by_user_id: ADMIN,
  expires_at: new Date("2026-09-20T00:00:00Z"),
  created_at: new Date(created),
  redeemed_at: redeemed ? new Date(redeemed) : null,
});

const perm = (org_id: string, pending_invite_id: string, permission: string) => ({
  org_id,
  user_id: null,
  pending_invite_id,
  permission,
  granted_by_user_id: ADMIN,
});

let db: FakeDb;

beforeEach(() => {
  db = {
    pending_invite: {
      columns: ["id", "org_id", "email", "role_template", "invited_by_user_id", "expires_at", "created_at", "redeemed_at"],
      rows: [
        invite(OLDER, ORG, "older@design-partner.test", "2026-09-10T00:00:00Z", null),
        invite(ELSEWHERE, OTHER_ORG, "someone@other-org.test", "2026-09-15T00:00:00Z", null),
        invite(REDEEMED, ORG, "joined@design-partner.test", "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z"),
        invite(NEWER, ORG, "newer@design-partner.test", "2026-09-16T00:00:00Z", null),
      ],
    },
    user_permission: {
      columns: ["org_id", "user_id", "pending_invite_id", "permission", "granted_by_user_id"],
      rows: [
        perm(ORG, OLDER, "patients.list"),
        perm(ORG, NEWER, "patients.view"),
        perm(ORG, NEWER, "visits.create"),
        perm(OTHER_ORG, ELSEWHERE, "billing.lookup.view"),
      ],
    },
  };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx(db)),
  );
});

describe("listInvites", () => {
  it("lists this org's outstanding invites only — not another org's, not a redeemed one", async () => {
    const rows = await listInvites({ orgId: ORG });
    expect(rows.map((r) => r.email)).toEqual([
      "newer@design-partner.test",
      "older@design-partner.test",
    ]);
  });

  it("carries each invite's own permission set", async () => {
    const rows = await listInvites({ orgId: ORG });
    expect(rows.find((r) => r.id === NEWER)?.permissions.sort()).toEqual(["patients.view", "visits.create"]);
    expect(rows.find((r) => r.id === OLDER)?.permissions).toEqual(["patients.list"]);
  });
});
