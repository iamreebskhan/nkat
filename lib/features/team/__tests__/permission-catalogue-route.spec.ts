/**
 * The permission catalogue, at the two places it has to hold.
 *
 * PUT /api/team/members/[userId] is the only way a permission set is written,
 * and its body schema accepted any string of up to 64 characters. A misspelt
 * permission was therefore INSERTed into user_permission, read back by
 * listMembers, and shown on /team as a grant — while no requireAuth list will
 * ever match it. The member is told they have access they do not have, and the
 * admin cannot tell the typo from a permission some screen does not use yet.
 *
 * The second half is the one that cannot be tested by spelling alone: because
 * any name was accepted, any SET was accepted, so a route reasoned about as
 * "every shipped template that grants this also grants that" was resting on a
 * property of the templates that this editor can violate. That is pinned where
 * the route is — lib/features/visits/__tests__/visit-access.spec.ts.
 *
 * Nothing here retypes the list of permissions. The catalogue is derived from
 * the shipped templates, so the tests drive the templates, and the "every
 * permission a route demands is grantable" test reads the routes on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
// Only setMemberPermissions, as member-permissions-route.spec.ts does: a stub
// that also handed over the schema would let the route import it from anywhere.
vi.mock("@/lib/features/team/team.service", () => ({
  setMemberPermissions: vi.fn().mockResolvedValue({ before: 3, after: 1 }),
}));

import { PUT } from "@/app/api/team/members/[userId]/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { setMemberPermissions } from "@/lib/features/team/team.service";
import {
  ALL_PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  unknownPermissionMessage,
} from "@/lib/features/team/team.types";

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

describe("PUT /api/team/members/[userId] — the names a set may contain", () => {
  it("refuses a misspelt permission without touching the member's grants", async () => {
    const res = await PUT(...put({ permissions: ["patients.view", "patients.vieww"] }));
    expect(res.status).toBe(422);
    expect(setMemberPermissions).not.toHaveBeenCalled();
  });

  it("gives the admin the offending name, not a field path", async () => {
    const res = await PUT(...put({ permissions: ["patients.view", "patients.vieww"] }));
    const body = await res.json();
    // Whole-string, for the same reason the empty-set message is checked whole:
    // lib/api's formatZodError prefixes any issue that carries a path, so a
    // rule attached to the array's third element would reach /team's red alert
    // box as "permissions.1: Not a permission…" — a field path dropped into the
    // middle of a sentence written for a person.
    expect(body.error).toBe(unknownPermissionMessage(["patients.vieww"]));
    expect(body.error).toContain('"patients.vieww"');
    expect(body.error.startsWith("permissions")).toBe(false);
    expect(body.success).toBe(false);
  });

  it("saves a set of real permissions — the check refuses names, not saving", async () => {
    // The control. A guard that refused every set would pass the two tests
    // above and break the editor completely.
    const res = await PUT(...put({ permissions: ["patients.view", "visits.view.all"] }));
    expect(res.status).toBe(200);
    expect(setMemberPermissions).toHaveBeenCalledWith({
      orgId: ORG,
      userId: MEMBER,
      permissions: ["patients.view", "visits.view.all"],
      grantedByUserId: ADMIN,
    });
  });

  it("saves the billing agent's own template unchanged", async () => {
    // The real shape of a save: /team ticks a template and posts the set back.
    const perms = ROLE_DEFAULT_PERMISSIONS.billing_agent;
    const res = await PUT(...put({ permissions: perms }));
    expect(res.status).toBe(200);
    expect(setMemberPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: perms }),
    );
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Which pattern found a name, so each one can be held to finding something. */
type Source = "requireAuth" | "session.permissions.includes" | "permission-shaped literal";
const SOURCES: Source[] = ["requireAuth", "session.permissions.includes", "permission-shaped literal"];

/**
 * Every permission string any route actually demands, read off the routes
 * rather than listed here. Three patterns, because a route gates in more than
 * one shape:
 *
 *   1. requireAuth([...]) — the usual one.
 *   2. session.permissions.includes("…") — the audit packet and the
 *      reconciliation both test the session directly.
 *   3. every permission-shaped literal in the file.
 *
 * The third is here because the first two see only INLINE literals, so a route
 * that gates on a shared constant array is invisible to them — and that is not
 * a hypothetical shape. app/api/billing/icd10/route.ts declares
 * `const READ_ANY = [...]` and gates on
 * `READ_ANY.some((p) => session.permissions.includes(p))`; its four
 * permissions were counted by neither pattern, so a NEW permission introduced
 * that way would have gated a route while being ungrantable on /team, and this
 * test would have stayed green.
 *
 * Shape-based rather than name-based (an array called PERMS, READ_ANY or
 * REQUIRED) on purpose: a constant named anything else slips past a name list
 * in silence, which is the exact failure this test exists to prevent. The cost
 * is a false alarm if a route ever holds a dotted lowercase literal that is
 * not a permission — there are none today, all 40 distinct matches under
 * app/api are permissions — and a tripwire that cries wolf is repairable in a
 * way that one that stays quiet is not. A future non-permission literal is
 * named by the failure message, with the file it came from.
 */
function permissionsRoutesDemand(): { permission: string; where: string; source: Source }[] {
  const found: { permission: string; where: string; source: Source }[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(e.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      const where = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      for (const call of src.matchAll(/requireAuth\(\[([^\]]*)\]/g)) {
        for (const p of call[1].matchAll(/"([^"]+)"/g)) {
          found.push({ permission: p[1], where, source: "requireAuth" });
        }
      }
      for (const p of src.matchAll(/permissions\.includes\("([^"]+)"\)/g)) {
        found.push({ permission: p[1], where, source: "session.permissions.includes" });
      }
      for (const p of src.matchAll(/"([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)"/g)) {
        found.push({ permission: p[1], where, source: "permission-shaped literal" });
      }
    }
  };
  walk(path.join(REPO_ROOT, "app", "api"));
  return found;
}

describe("the catalogue against the routes on disk", () => {
  it("can grant every permission a route asks for", () => {
    // The other direction of the same rule, and the one an allowlist gets
    // wrong: a permission that gates a screen but is in no template cannot be
    // ticked on /team at all, so the screen belongs to nobody but the org
    // admin template — and with this schema in place, an admin who typed it by
    // hand would now be refused rather than quietly granted nothing.
    const demanded = permissionsRoutesDemand();
    // Guard against the scan silently finding nothing: the routes demand
    // dozens of permissions, and a regex that matched none would make the
    // assertion below vacuously true.
    expect(demanded.length).toBeGreaterThan(40);
    // Per pattern as well as in total, because the three cover different
    // gating shapes: one of them going blind is invisible in the total, which
    // the other two alone already carry past 40.
    for (const source of SOURCES) {
      expect(demanded.filter((d) => d.source === source).length, source).toBeGreaterThan(0);
    }
    const ungrantable = demanded
      .filter((d) => !ALL_PERMISSIONS.includes(d.permission))
      .map((d) => `${d.permission} (${d.where}, via ${d.source})`);
    expect(ungrantable).toEqual([]);
  });
});
