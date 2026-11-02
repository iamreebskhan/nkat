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

  it("gives the intake coordinator the referral board, their patients, the schedule and the team's tasks, landing on the board", () => {
    expect(hrefs("intake_coordinator", ROLE_DEFAULT_PERMISSIONS.intake_coordinator)).toEqual([
      "/referrals",
      "/patients",
      "/schedule",
      "/tasks",
    ]);
    expect(MANIFESTS.intake_coordinator.defaultRoute).toBe("/referrals");
  });

  it("gives the care team their caseload and tasks between visits (0116)", () => {
    for (const role of ["clinician", "org_admin"] as const) {
      expect(hrefs(role, ROLE_DEFAULT_PERMISSIONS[role])).toEqual(expect.arrayContaining(["/caseload", "/tasks"]));
    }
    // A task can be anyone's, so Tasks needs no grant; the billing team gets administrative ones.
    expect(hrefs("billing_agent", ROLE_DEFAULT_PERMISSIONS.billing_agent)).toContain("/tasks");
    // CONTROL: the caseload is patients, so it needs the grant to read them.
    expect(hrefs("clinician", ["visits.view.own"])).not.toContain("/caseload");
  });

  it("puts the referral board before whoever receives referrals or triages them, and no one else", () => {
    expect(hrefs("org_admin", ROLE_DEFAULT_PERMISSIONS.org_admin)).toContain("/referrals");
    expect(hrefs("clinician", ROLE_DEFAULT_PERMISSIONS.clinician)).toContain("/referrals");
    // CONTROL: the board needs the grant its screens act with.
    expect(hrefs("clinician", ["patients.list", "patients.view"])).not.toContain("/referrals");
    expect(hrefs("intake_coordinator", ["patients.list"])).not.toContain("/referrals");
  });

  it("puts the KPI report in the sidebar of anyone granted reports.view, and of no one else", () => {
    for (const role of ["clinician", "billing_agent", "org_admin", "consultant", "read_only"] as const) {
      expect(hrefs(role, ["reports.view"]), role).toContain("/reports");
      // CONTROL: the report needs the grant its route checks.
      expect(hrefs(role, []), role).not.toContain("/reports");
    }
    expect(hrefs("org_admin", ROLE_DEFAULT_PERMISSIONS.org_admin)).toContain("/reports");
    expect(hrefs("read_only", ROLE_DEFAULT_PERMISSIONS.read_only)).toContain("/reports");
  });

  it("puts the clearinghouse page before the billing team and the admin, and no one else (0120)", () => {
    for (const role of ["billing_agent", "org_admin"] as const) {
      expect(hrefs(role, ROLE_DEFAULT_PERMISSIONS[role]), role).toContain("/billing/clearinghouse");
      // CONTROL: the page lists claims, so it needs the grant its routes check.
      expect(hrefs(role, []), role).not.toContain("/billing/clearinghouse");
    }
    expect(hrefs("clinician", ROLE_DEFAULT_PERMISSIONS.clinician)).not.toContain("/billing/clearinghouse");
  });

  it("shows neither to someone without the permission", () => {
    for (const role of ["clinician", "billing_agent", "consultant", "analyst", "read_only"] as const) {
      expect(hrefs(role, [])).not.toContain("/audit");
      expect(hrefs(role, [])).not.toContain("/payers/attestations");
    }
  });
});
