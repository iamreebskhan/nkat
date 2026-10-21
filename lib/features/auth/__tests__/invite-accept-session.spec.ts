/**
 * The session POST /api/invites/[token]/accept mints.
 *
 * login() is not the only place a session is created. Accepting an invite
 * signs the user straight in, and it built session.permissions from the SAME
 * unfiltered read login() used to carry: user_id only, no org predicate.
 * lib/auth.ts requireAuth() gates every route on session.permissions alone —
 * there is no per-request re-read — so that array IS the user's authority
 * until the token expires.
 *
 * That matters here more than anywhere, because this endpoint is the one that
 * routinely runs for somebody who already holds grants elsewhere:
 * invite-redeem.service.ts reuses the existing app_user row when the invited
 * address is already on file, so a second-org seat is an ordinary flow rather
 * than a fixture artifact. .env.local notes the preview deployment connects as
 * a superuser, which bypasses RLS on every table regardless of FORCE, so
 * app.current_org_id bounds nothing there and the statement's own predicates
 * are the only filter left; on that connection the read without the org
 * predicate returned all 8 of multi@example.test's grants against the 4 held
 * in the org being joined. A grant of team.permissions made in one tenant
 * became effective in the other the moment its holder accepted an invite.
 *
 * The real handler runs. Only redeemInvite, the session cookie and the
 * database are stood in for — and the database is stood in for by RUNNING the
 * route's own statement against modelled user_permission rows through
 * lib/features/team/__tests__/sql-fake.ts, so the statement decides what comes
 * back rather than this file restating the rule it is supposed to follow.
 *
 * It lives under lib/ because the runner only collects specs from lib/,
 * components/ and scripts/ (see vitest.config.ts); signup-baa-route.spec.ts
 * pins an app/api route from this folder for the same reason.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ withOrgContext: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  setSessionCookie: vi.fn(),
  signSession: vi.fn().mockResolvedValue("signed-token"),
}));
vi.mock("@/lib/features/team/invite-redeem.service", () => ({ redeemInvite: vi.fn() }));

import { POST } from "@/app/api/invites/[token]/accept/route";
import { signSession, type Session } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import { fakeTx, type FakeDb } from "@/lib/features/team/__tests__/sql-fake";
import { redeemInvite } from "@/lib/features/team/invite-redeem.service";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
/** The org whose invite is being accepted in the CONTROL below. */
const ORG_B = "22222222-2222-4222-8222-222222222222";
/** Another member of ORG, whose grant must never reach this session. */
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** user_permission as the rows it actually holds, for two orgs and two users. */
const GRANTS = [
  { org_id: ORG, user_id: USER, permission: "patients.view" },
  { org_id: ORG_B, user_id: USER, permission: "team.permissions" },
  { org_id: ORG, user_id: OTHER_USER, permission: "billing.superbills.void" },
];

/** A well-formed token: the route refuses anything that is not 48 hex chars. */
const TOKEN = "a1b2c3d4e5f6".repeat(4);

type Redeemed = Extract<Awaited<ReturnType<typeof redeemInvite>>, { userId: string }>;

let db: FakeDb;
let redeemed: Redeemed | { error: "expired_or_invalid" };

beforeEach(() => {
  vi.clearAllMocks();
  db = {
    user_permission: {
      columns: ["org_id", "user_id", "permission"],
      rows: GRANTS.map((g) => ({ ...g })),
    },
  };
  redeemed = {
    userId: USER,
    orgId: ORG,
    email: "invited@example.test",
    newUser: false,
    roleTemplate: "clinician",
  };
  vi.mocked(redeemInvite).mockImplementation(async () => redeemed);
  // sql-fake parses the statement the route sent and evaluates its clauses
  // against `db`. It has no RLS — each table holds rows for more than one org,
  // which is what the RLS-bypassing connection described above sees — and it
  // fails closed, so a rewrite it cannot model throws instead of passing.
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx(db)),
  );
});

const accept = async () => {
  const req = new Request(`http://localhost/api/invites/${TOKEN}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: "Invited Person", password: "quiet-harbor-lantern-49" }),
  }) as unknown as NextRequest;
  const res = await POST(req, { params: Promise.resolve({ token: TOKEN }) });
  return { status: res.status };
};

/** The session the route actually signed. */
const minted = (): Session => {
  expect(signSession).toHaveBeenCalledTimes(1);
  return vi.mocked(signSession).mock.calls[0]![0] as Session;
};

describe("POST /api/invites/[token]/accept — the session it mints", () => {
  it("carries the grants held in the org just joined, and not the user's other org", async () => {
    // USER holds team.permissions in ORG_B — the right to hand out permissions
    // — and is accepting a seat in ORG, where they hold only patients.view.
    expect((await accept()).status).toBe(200);
    const session = minted();
    expect(session.orgId).toBe(ORG);
    expect(session.permissions).toEqual(["patients.view"]);
    expect(session.permissions).not.toContain("team.permissions");
    // And the read runs under the org the invite was for, not some other one.
    expect(withOrgContext).toHaveBeenCalledWith(ORG, expect.any(Function));
  });

  it("CONTROL — the same user accepting into the other org gets that org's grant", async () => {
    // Without this the assertion above would also be satisfied by a statement
    // that binds a constant org id, or that returns nothing at all.
    redeemed = { ...(redeemed as Redeemed), orgId: ORG_B };
    expect((await accept()).status).toBe(200);
    const session = minted();
    expect(session.orgId).toBe(ORG_B);
    expect(session.permissions).toEqual(["team.permissions"]);
  });

  it("CONTROL — never another member's grants in the org being joined", async () => {
    // OTHER_USER holds billing.superbills.void — voiding a submitted superbill
    // — in the very org being joined. A read that lost the user binding, or
    // that ORed the two predicates instead of ANDing them, would hand it to
    // whoever accepted the next invite.
    expect((await accept()).status).toBe(200);
    expect(minted().permissions).not.toContain("billing.superbills.void");
  });

  it("mints no session at all when the invite does not redeem", async () => {
    redeemed = { error: "expired_or_invalid" };
    expect((await accept()).status).toBe(410);
    expect(withOrgContext).not.toHaveBeenCalled();
    expect(signSession).not.toHaveBeenCalled();
  });
});
