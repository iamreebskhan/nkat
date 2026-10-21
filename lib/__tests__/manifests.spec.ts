/**
 * Every permission a sidebar item needs can be granted, and granting the
 * audit-log or attestation permission gives a member somewhere to use it
 * (audit R38).
 */
import { describe, expect, it } from "vitest";

import { ROLE_DEFAULT_PERMISSIONS } from "@/lib/features/team/team.types";
import { MANIFESTS, visibleNavItems } from "@/lib/manifests";

const GRANTABLE = new Set(Object.values(ROLE_DEFAULT_PERMISSIONS).flat());
const hrefs = (role: keyof typeof MANIFESTS, perms: string[]) =>
  visibleNavItems(MANIFESTS[role], perms).map((i) => i.href);

describe("manifests", () => {
  it("only requires permissions the team screen can grant", () => {
    for (const [role, m] of Object.entries(MANIFESTS)) {
      for (const item of m.primary) {
        if (item.requires) expect(GRANTABLE.has(item.requires), `${role}: ${item.requires}`).toBe(true);
      }
    }
  });

  it("puts the audit log in the sidebar of anyone granted audit.view", () => {
    for (const role of ["clinician", "billing_agent", "consultant", "analyst", "read_only"] as const) {
      expect(hrefs(role, ["audit.view"]), role).toContain("/audit");
    }
  });

  it("puts attestations in the sidebar of anyone granted knowledge.attest", () => {
    for (const role of ["clinician", "billing_agent", "consultant", "analyst"] as const) {
      expect(hrefs(role, ["knowledge.attest"]), role).toContain("/payers/attestations");
    }
  });

  it("shows neither to someone without the permission", () => {
    for (const role of ["clinician", "billing_agent", "consultant", "analyst", "read_only"] as const) {
      expect(hrefs(role, [])).not.toContain("/audit");
      expect(hrefs(role, [])).not.toContain("/payers/attestations");
    }
  });
});
