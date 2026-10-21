/**
 * PUT /api/team/members/[userId] — the route that saves the /team permission
 * editor.
 *
 * It used to declare its own body schema, `z.array(z.string()).max(80)` with
 * no minimum, so it did not inherit the "at least one" rule the invite path
 * has always enforced: unticking every box and pressing Save was accepted, and
 * the service then deleted every grant the member had. The schema is shared
 * now, so the refusal happens before the service is ever called.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
// The service is stubbed because it opens a tx, and the stub supplies ONLY
// setMemberPermissions. The route has to get its schema from team.types. This
// stub used to hand the schema over as well, which hid the one wiring fault
// that matters: if the service stopped re-exporting it, a route importing it
// from there would call parseJson(req, undefined) and 500 on every save, with
// this spec still green. Without the schema here, a route that imports it from
// the service fails these tests.
vi.mock("@/lib/features/team/team.service", () => ({
  setMemberPermissions: vi.fn().mockResolvedValue({ before: 3, after: 1 }),
}));

import { PUT } from "@/app/api/team/members/[userId]/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { setMemberPermissions } from "@/lib/features/team/team.service";
import { PERMISSION_SET_REQUIRED } from "@/lib/features/team/team.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SESSION: Session = {
  userId: ADMIN,
  orgId: ORG,
  role: "org_admin",
  permissions: ["team.view", "team.permissions"],
  email: "admin@design-partner.test",
};

function put(body: unknown): [NextRequest, { params: Promise<{ userId: string }> }] {
  const req = new Request(`http://localhost/api/team/members/${MEMBER}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ userId: MEMBER }) }];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(SESSION);
  vi.mocked(setMemberPermissions).mockResolvedValue({ before: 3, after: 1 });
});

describe("PUT /api/team/members/[userId]", () => {
  it("refuses an empty permission set without touching the member's grants", async () => {
    const res = await PUT(...put({ permissions: [] }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/at least one permission/i);
    expect(setMemberPermissions).not.toHaveBeenCalled();
  });

  it("tells the admin what to do instead of clearing the set", async () => {
    const res = await PUT(...put({ permissions: [] }));
    const body = await res.json();
    // The copy has to be true: /team cannot remove a member today, so it says
    // to narrow the set rather than promising a button that does not exist.
    expect(body.error).toMatch(/untick what they should lose/i);
    // Checked whole, not by substring. /team shows this string in its red
    // alert box, and a rule attached to the `permissions` field comes back
    // from lib/api's formatZodError as "permissions: A member must…". That
    // prefix is a field name in the middle of a sentence written for a person,
    // and a substring match would not notice it.
    expect(body.error).toBe(PERMISSION_SET_REQUIRED);
  });

  it("saves a set with one permission in it", async () => {
    const res = await PUT(...put({ permissions: ["patients.view"] }));
    expect(res.status).toBe(200);
    expect(setMemberPermissions).toHaveBeenCalledWith({
      orgId: ORG,
      userId: MEMBER,
      permissions: ["patients.view"],
      grantedByUserId: ADMIN,
    });
  });
});
