/**
 * Role templates: what a member's session renders from, and what each
 * template grants by default (audit R38).
 */
import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  InviteSchema,
  MemberPermissionsSchema,
  ROLE_DEFAULT_PERMISSIONS,
  sessionRoleFor,
  unknownPermissionMessage,
} from "../team.types";

describe("sessionRoleFor", () => {
  it("uses the template the member was invited with", () => {
    expect(sessionRoleFor("billing_agent", "employee")).toBe("billing_agent");
    expect(sessionRoleFor("analyst", "employee")).toBe("analyst");
    expect(sessionRoleFor("read_only", "employee")).toBe("read_only");
  });

  it("falls back to the legacy role mapping when no template is recorded", () => {
    expect(sessionRoleFor(null, "admin")).toBe("org_admin");
    expect(sessionRoleFor(null, "reviewer")).toBe("analyst");
    expect(sessionRoleFor(null, "consultant")).toBe("consultant");
    expect(sessionRoleFor(null, "employee")).toBe("clinician");
  });

  it("ignores a template that is not one of ours", () => {
    expect(sessionRoleFor("bogus", "consultant")).toBe("consultant");
  });
});

describe("role defaults", () => {
  it("lets a read-only member read the audit log", () => {
    expect(ROLE_DEFAULT_PERMISSIONS.read_only).toContain("audit.view");
  });

  it("lets a billing agent attest what a payer said — they place the calls", () => {
    expect(ROLE_DEFAULT_PERMISSIONS.billing_agent).toContain("knowledge.attest");
  });

  it("keeps the consultant template empty", () => {
    expect(ROLE_DEFAULT_PERMISSIONS.consultant).toEqual([]);
  });
});

describe("InviteSchema", () => {
  it("refuses an invite that grants nothing — a consultant invite used to", () => {
    const r = InviteSchema.safeParse({ email: "c@local.test", roleTemplate: "consultant", permissions: [] });
    expect(r.success).toBe(false);
  });

  it("accepts an invite with at least one permission", () => {
    const r = InviteSchema.safeParse({
      email: "c@local.test", roleTemplate: "consultant", permissions: ["knowledge.view"],
    });
    expect(r.success).toBe(true);
  });
});

describe("MemberPermissionsSchema", () => {
  it("refuses an empty set — editing a member used to accept one and wipe every grant", () => {
    const r = MemberPermissionsSchema.safeParse({ permissions: [] });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]!.message).toMatch(/at least one permission/i);
  });

  it("accepts a set with one permission in it", () => {
    expect(MemberPermissionsSchema.safeParse({ permissions: ["patients.view"] }).success).toBe(true);
  });
});

/**
 * Which NAMES a permission set may contain.
 *
 * The array was z.string().max(64) with no allowlist, so the member editor
 * accepted any 64 characters and stored them as grants. Two things came of
 * that: a misspelt permission is saved, listed back on /team and matched by no
 * requireAuth list — access that reads as granted and is not — and any set at
 * all could be put on a member, so a route reasoned about as "no shipped
 * template grants this without that" was resting on a property the editor can
 * violate (see lib/features/visits/__tests__/visit-access.spec.ts, superbill).
 *
 * The catalogue is derived from the templates, so these tests drive the
 * templates themselves rather than a hand-copied list of permission names: a
 * list retyped here would agree with a wrong catalogue.
 */
describe("the permission catalogue", () => {
  it("offers every permission the shipped templates grant", () => {
    for (const [role, perms] of Object.entries(ROLE_DEFAULT_PERMISSIONS)) {
      for (const p of perms) expect(ALL_PERMISSIONS, `${role} grants ${p}`).toContain(p);
    }
  });

  it("accepts each shipped template whole — picking a template and saving still works", () => {
    for (const [role, perms] of Object.entries(ROLE_DEFAULT_PERMISSIONS)) {
      // consultant starts empty by design; the "at least one" rule above owns
      // that case, and an admin has to tick something before saving.
      if (perms.length === 0) continue;
      expect(MemberPermissionsSchema.safeParse({ permissions: perms }).success, role).toBe(true);
    }
  });

  it("refuses a name this product does not define, even beside a real one", () => {
    const r = MemberPermissionsSchema.safeParse({
      permissions: ["patients.view", "patients.vieww"],
    });
    expect(r.success).toBe(false);
  });

  it("refuses the shapes a copied or hand-written set arrives in", () => {
    // A wildcard, a role name mistaken for a permission, and the right
    // permission in the wrong case or with a stray space — each of which today
    // would be stored and grant nothing.
    for (const bad of ["*", "admin", "billing.*", "Patients.View", "patients.view "]) {
      expect(
        MemberPermissionsSchema.safeParse({ permissions: [bad] }).success,
        bad,
      ).toBe(false);
    }
  });

  it("names what it refused and leaves the valid ones out of the message", () => {
    const r = MemberPermissionsSchema.safeParse({
      permissions: ["patients.view", "patients.vieww", "visits.view.any"],
    });
    const message = r.success === false ? r.error.issues[0]!.message : "";
    // The admin has to be able to see WHICH box they meant; a refusal that only
    // says "invalid permissions" sends them back to a grid of 48 checkboxes.
    expect(message).toContain('"patients.vieww"');
    expect(message).toContain('"visits.view.any"');
    expect(message).not.toContain('"patients.view"');
    expect(message).toBe(unknownPermissionMessage(["patients.vieww", "visits.view.any"]));
  });

  it("holds the invite form to the same catalogue", () => {
    // Both paths build on one PermissionSet on purpose: a typo refused in the
    // editor and accepted at invite time would just move the broken grant a day
    // earlier, into a member who has never signed in to notice.
    const r = InviteSchema.safeParse({
      email: "c@local.test",
      roleTemplate: "consultant",
      permissions: ["knowledge.viewer"],
    });
    expect(r.success).toBe(false);
  });

  it("still refuses the empty set with the sentence written for the admin", () => {
    // The catalogue check must not have displaced it: an empty set has no
    // unknown names, so this issue is the one that reaches the red box.
    const r = MemberPermissionsSchema.safeParse({ permissions: [] });
    expect(r.success === false && r.error.issues[0]!.message).toMatch(/at least one permission/i);
  });
});
